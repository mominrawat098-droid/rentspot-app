const express = require("express");
const session = require("express-session");
const path = require("path");
const multer = require("multer");
const db = require("./database");

const app = express();

// ===== MIDDLEWARE =====
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.use(
  session({
    secret: "rentspot_secret_123",
    resave: false,
    saveUninitialized: false,
  })
);

app.set("view engine", "ejs");

// ===== HELPERS =====
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") return res.redirect("/login");
  next();
}

function notifyUser(toUserId, subject, message) {
  db.run(
    "INSERT INTO messages (to_user_id, subject, message, is_read) VALUES (?,?,?,0)",
    [toUserId, subject, message]
  );
}

function renderWithUnread(req, res, view, data) {
  const user = req.session.user || null;

  if (!user) return res.render(view, { ...data, user: null, unread: 0 });

  db.get(
    "SELECT COUNT(*) AS c FROM messages WHERE to_user_id=? AND is_read=0",
    [user.id],
    (err, row) => {
      const unread = row ? row.c : 0;
      res.render(view, { ...data, user, unread });
    }
  );
}

// ===== UPLOADS =====
const propertyStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, "p_" + Date.now() + path.extname(file.originalname)),
});
const uploadPropertyImage = multer({ storage: propertyStorage });

const qrStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, "qr_" + Date.now() + path.extname(file.originalname)),
});
const uploadQR = multer({ storage: qrStorage });

// ======================= AUTH =======================
app.get("/login", (req, res) => res.render("login", { error: null }));

app.post("/login", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = (req.body.password || "").trim();

  db.get("SELECT * FROM users WHERE lower(email)=? AND password=?", [email, password], (err, user) => {
    if (err) return res.render("login", { error: "DB error" });
    if (!user) return res.render("login", { error: "Invalid email or password" });

    // user needs approval
    if (user.role !== "admin" && user.status !== "Approved") {
      return res.render("login", { error: "Your account is pending admin approval" });
    }

    req.session.user = user;
    if (user.role === "admin") return res.redirect("/admin");
    return res.redirect("/");
  });
});

app.get("/register", (req, res) => res.render("register", { error: null, success: null }));

app.post("/register", (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = (req.body.password || "").trim();

  if (!name || !email || !password) {
    return res.render("register", { error: "All fields are required", success: null });
  }

  db.run(
    "INSERT INTO users (name,email,password,role,status) VALUES (?,?,?,?,?)",
    [name, email, password, "user", "Pending"],
    function (err) {
      if (err) return res.render("register", { error: "Email already exists", success: null });

      // notify admin
      db.get("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1", (e2, admin) => {
        if (admin) notifyUser(admin.id, "New User Registered", `User: ${name} (${email}) pending approval.`);
      });

      res.render("login", { error: "Registered. Wait for admin approval." });
    }
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ======================= HOME =======================
app.get("/", (req, res) => {
  const q = (req.query.q || "").trim();
  const min = req.query.min ? Number(req.query.min) : null;
  const max = req.query.max ? Number(req.query.max) : null;

  let where = " WHERE 1=1 ";
  const params = [];

  if (q) {
    where += " AND (p.title LIKE ? OR p.location LIKE ?) ";
    params.push(`%${q}%`, `%${q}%`);
  }
  if (min !== null && !Number.isNaN(min)) {
    where += " AND p.price >= ? ";
    params.push(min);
  }
  if (max !== null && !Number.isNaN(max)) {
    where += " AND p.price <= ? ";
    params.push(max);
  }

  const sql = `
    SELECT p.*,
      (SELECT ROUND(AVG(stars),1) FROM ratings r WHERE r.property_id=p.id) AS avg_rating,
      (SELECT COUNT(*) FROM ratings r WHERE r.property_id=p.id) AS rating_count
    FROM properties p
    ${where}
    ORDER BY p.id DESC
  `;

  db.all(sql, params, (err, properties) => {
    if (err) return res.send("Home error: " + err.message);
    renderWithUnread(req, res, "index", { properties: properties || [], filters: { q, min, max } });
  });
});

// ======================= PROPERTY VIEW =======================
app.get("/property/:id", (req, res) => {
  const id = req.params.id;

  db.get(
    `SELECT p.*,
      (SELECT ROUND(AVG(stars),1) FROM ratings r WHERE r.property_id=p.id) AS avg_rating,
      (SELECT COUNT(*) FROM ratings r WHERE r.property_id=p.id) AS rating_count
     FROM properties p WHERE p.id=?`,
    [id],
    (err, property) => {
      if (err || !property) return res.send("Property not found");

      db.all(
        "SELECT r.*, u.name FROM ratings r JOIN users u ON u.id=r.user_id WHERE r.property_id=? ORDER BY r.id DESC",
        [id],
        (e2, reviews) => {
          renderWithUnread(req, res, "property", { property, reviews: reviews || [] });
        }
      );
    }
  );
});

app.post("/property/:id/rate", requireLogin, (req, res) => {
  const propertyId = req.params.id;
  const stars = Number(req.body.stars || 0);
  const comment = (req.body.comment || "").trim();
  const userId = req.session.user.id;

  if (stars < 1 || stars > 5) return res.redirect("/property/" + propertyId);

  db.run(
    "INSERT INTO ratings (user_id, property_id, stars, comment) VALUES (?,?,?,?)",
    [userId, propertyId, stars, comment],
    () => res.redirect("/property/" + propertyId)
  );
});

// ======================= BOOKING =======================
app.get("/book/:propertyId", requireLogin, (req, res) => {
  db.get("SELECT * FROM properties WHERE id=?", [req.params.propertyId], (err, p) => {
    if (err || !p) return res.send("PG not found");
    renderWithUnread(req, res, "book", { property: p, error: null });
  });
});

app.post("/book/:propertyId", requireLogin, (req, res) => {
  const propertyId = req.params.propertyId;
  const userId = req.session.user.id;

  const full_name = (req.body.full_name || "").trim();
  const phone = (req.body.phone || "").trim();
  const persons = Number(req.body.persons || 1);
  const checkin_date = (req.body.checkin_date || "").trim();
  const checkout_date = (req.body.checkout_date || "").trim();

  if (!full_name || !phone || !checkin_date || !checkout_date) return res.redirect("/book/" + propertyId);

  db.get("SELECT * FROM properties WHERE id=?", [propertyId], (err, p) => {
    if (err || !p) return res.send("PG not found");

    const amount = Number(p.price || 0);

    db.run(
      `INSERT INTO bookings (
        user_id, property_id, full_name, phone, persons, checkin_date, checkout_date, amount,
        approval_status, payment_status, payment_method, transaction_id
      ) VALUES (?,?,?,?,?,?,?,?,'Pending','Pending','','')`,
      [userId, propertyId, full_name, phone, persons, checkin_date, checkout_date, amount],
      function (e2) {
        if (e2) return res.send("Booking error: " + e2.message);

        db.get("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1", (e3, admin) => {
          if (admin) notifyUser(admin.id, "New Booking", `Booking request for "${p.title}" by ${req.session.user.email}`);
        });

        res.redirect("/my-bookings");
      }
    );
  });
});

app.get("/my-bookings", requireLogin, (req, res) => {
  const userId = req.session.user.id;

  const sql = `
    SELECT b.*,
      p.title AS property_title,
      p.location AS property_location,
      IFNULL(p.contact_phone,'') AS contact_phone
    FROM bookings b
    JOIN properties p ON p.id=b.property_id
    WHERE b.user_id=?
    ORDER BY b.id DESC
  `;

  db.all(sql, [userId], (err, bookings) => {
    if (err) return res.send("My bookings error: " + err.message);
    renderWithUnread(req, res, "my-bookings", { bookings: bookings || [] });
  });
});

// ======================= PAY (FIX) =======================
app.get("/pay/:bookingId", requireLogin, (req, res) => {
  const bookingId = req.params.bookingId;
  const userId = req.session.user.id;

  db.get(
    `SELECT b.*,
      p.title AS property_title,
      p.location AS property_location
     FROM bookings b
     JOIN properties p ON p.id=b.property_id
     WHERE b.id=? AND b.user_id=?`,
    [bookingId, userId],
    (err, booking) => {
      if (err || !booking) return res.redirect("/my-bookings");

      if (booking.approval_status !== "Approved") return res.redirect("/my-bookings");

      db.get("SELECT * FROM settings WHERE id=1", (e2, settings) => {
        if (e2) return res.send("Payment settings error: " + e2.message);
        renderWithUnread(req, res, "pay", { booking, settings: settings || { upi_id: "", qr_image: "" } });
      });
    }
  );
});

app.post("/pay/:bookingId", requireLogin, (req, res) => {
  const bookingId = req.params.bookingId;
  const userId = req.session.user.id;

  const transaction_id = (req.body.transaction_id || "").trim();
  if (!transaction_id) return res.redirect("/pay/" + bookingId);

  db.run(
    `UPDATE bookings
     SET payment_status='Paid', payment_method='UPI', transaction_id=?
     WHERE id=? AND user_id=?`,
    [transaction_id, bookingId, userId],
    (err) => {
      if (err) return res.send("Payment update error: " + err.message);

      notifyUser(userId, "Payment Submitted ✅", `Payment submitted for booking #${bookingId}.`);

      db.get("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1", (e2, admin) => {
        if (admin) notifyUser(admin.id, "Payment Submitted", `Booking #${bookingId} paid. Txn: ${transaction_id}`);
        res.redirect("/my-bookings");
      });
    }
  );
});

// ======================= MESSAGES =======================
app.get("/messages", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  db.all("SELECT * FROM messages WHERE to_user_id=? ORDER BY id DESC", [userId], (err, messages) => {
    if (err) return res.send("Messages error: " + err.message);
    renderWithUnread(req, res, "messages", { messages: messages || [] });
  });
});

app.post("/messages/:id/read", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  db.run("UPDATE messages SET is_read=1 WHERE id=? AND to_user_id=?", [req.params.id, userId], () =>
    res.redirect("/messages")
  );
});

// ======================= ADMIN =======================
app.get("/admin", requireAdmin, (req, res) => {
  db.all(
    `SELECT b.*,
      u.name AS user_name, u.email AS user_email,
      p.title AS property_title, p.location AS property_location
     FROM bookings b
     JOIN users u ON u.id=b.user_id
     JOIN properties p ON p.id=b.property_id
     ORDER BY b.id DESC`,
    [],
    (err, bookings) => {
      if (err) return res.send("Admin error: " + err.message);
      renderWithUnread(req, res, "admin-dashboard", { bookings: bookings || [], s: "" });
    }
  );
});

// ✅ booking approve/reject
app.post("/admin/booking/:id/approve", requireAdmin, (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM bookings WHERE id=?", [id], (err, b) => {
    if (err || !b) return res.redirect("/admin");

    db.run("UPDATE bookings SET approval_status='Approved' WHERE id=?", [id], (e2) => {
      if (e2) return res.send("Booking approve error: " + e2.message);

      notifyUser(b.user_id, "Booking Approved ✅", `Your booking #${id} is approved. Now you can pay.`);
      res.redirect("/admin");
    });
  });
});

app.post("/admin/booking/:id/reject", requireAdmin, (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM bookings WHERE id=?", [id], (err, b) => {
    if (err || !b) return res.redirect("/admin");

    db.run("UPDATE bookings SET approval_status='Rejected' WHERE id=?", [id], (e2) => {
      if (e2) return res.send("Booking reject error: " + e2.message);

      notifyUser(b.user_id, "Booking Rejected ❌", `Your booking #${id} has been rejected by admin.`);
      res.redirect("/admin");
    });
  });
});

// users page
app.get("/admin/users", requireAdmin, (req, res) => {
  db.all("SELECT * FROM users WHERE role='user' ORDER BY id DESC", (err, users) => {
    if (err) return res.send("Admin users error: " + err.message);
    renderWithUnread(req, res, "admin-users", { users: users || [] });
  });
});

app.post("/admin/users/approve/:id", requireAdmin, (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM users WHERE id=?", [id], (err, user) => {
    if (err || !user) return res.redirect("/admin/users");

    db.run("UPDATE users SET status='Approved' WHERE id=?", [id], (e2) => {
      if (e2) return res.send("Approve error: " + e2.message);

      notifyUser(user.id, "Account Approved ✅", "Your account has been approved. You can now login and book PG.");
      res.redirect("/admin/users");
    });
  });
});

app.post("/admin/users/reject/:id", requireAdmin, (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM users WHERE id=?", [id], (err, user) => {
    if (err || !user) return res.redirect("/admin/users");

    db.run("UPDATE users SET status='Rejected' WHERE id=?", [id], (e2) => {
      if (e2) return res.send("Reject error: " + e2.message);

      notifyUser(user.id, "Account Rejected ❌", "Your account has been rejected by admin.");
      res.redirect("/admin/users");
    });
  });
});

// add property
app.get("/admin/properties/add", requireAdmin, (req, res) => {
  renderWithUnread(req, res, "admin-property-form", { mode: "add", property: null, error: null });
});

app.post("/admin/properties/add", requireAdmin, uploadPropertyImage.single("image"), (req, res) => {
  const title = (req.body.title || "").trim();
  const location = (req.body.location || "").trim();
  const description = (req.body.description || "").trim();
  const price = Number(req.body.price || 0);
  const contact_phone = (req.body.contact_phone || "").trim();
  const image = req.file ? req.file.filename : null;

  if (!title || !location || !price) {
    return renderWithUnread(req, res, "admin-property-form", {
      mode: "add",
      property: null,
      error: "Title, location, price required",
    });
  }

  db.run(
    "INSERT INTO properties (title,location,description,price,image,contact_phone) VALUES (?,?,?,?,?,?)",
    [title, location, description, price, image, contact_phone],
    (err) => {
      if (err) return res.send("Add PG error: " + err.message);
      res.redirect("/");
    }
  );
});

// admin send message
app.get("/admin/message", requireAdmin, (req, res) => {
  db.all("SELECT id, name, email FROM users WHERE role='user' ORDER BY id DESC", (err, users) => {
    renderWithUnread(req, res, "admin-message", { users: users || [], error: null, success: null });
  });
});

app.post("/admin/message", requireAdmin, (req, res) => {
  const to_user_id = Number(req.body.to_user_id || 0);
  const subject = (req.body.subject || "").trim();
  const message = (req.body.message || "").trim();

  db.all("SELECT id, name, email FROM users WHERE role='user' ORDER BY id DESC", (err, users) => {
    if (!to_user_id || !subject || !message) {
      return renderWithUnread(req, res, "admin-message", {
        users: users || [],
        error: "All fields required",
        success: null,
      });
    }

    notifyUser(to_user_id, subject, message);
    renderWithUnread(req, res, "admin-message", { users: users || [], error: null, success: "Message sent ✅" });
  });
});

// payment settings
app.get("/admin/payment", requireAdmin, (req, res) => {
  db.get("SELECT * FROM settings WHERE id=1", (err, settings) => {
    if (err) return res.render("admin-payment", { settings: null, error: err.message, success: null });

    if (!settings) {
      db.run("INSERT INTO settings (id, upi_id, qr_image) VALUES (1,'','')", () => {
        db.get("SELECT * FROM settings WHERE id=1", (e2, settings2) => {
          res.render("admin-payment", { settings: settings2, error: null, success: null });
        });
      });
      return;
    }

    res.render("admin-payment", { settings, error: null, success: null });
  });
});

app.post("/admin/payment", requireAdmin, uploadQR.single("qr"), (req, res) => {
  const upi_id = (req.body.upi_id || "").trim();

  db.get("SELECT * FROM settings WHERE id=1", (err, old) => {
    if (err) return res.render("admin-payment", { settings: null, error: err.message, success: null });

    const qr_image = req.file ? req.file.filename : (old ? old.qr_image : "");

    db.run("UPDATE settings SET upi_id=?, qr_image=? WHERE id=1", [upi_id, qr_image], (e2) => {
      if (e2) return res.render("admin-payment", { settings: old, error: e2.message, success: null });

      db.get("SELECT * FROM settings WHERE id=1", (e3, settings2) => {
        if (e3) return res.render("admin-payment", { settings: null, error: e3.message, success: null });
        res.render("admin-payment", { settings: settings2, error: null, success: "Saved ✅" });
      });
    });
  });
});

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));