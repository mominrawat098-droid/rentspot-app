require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const { run, get, all, initSchema } = require("./database");
const { sendMail } = require("./mailer");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: false
  })
);

// ---------- Multer for multiple images ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "public", "uploads")),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});
const upload = multer({ storage });

// ---------- Helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "admin") return res.status(403).send("Forbidden");
  next();
}
async function adminUnreadCount() {
  const row = await get(`SELECT COUNT(*) as c FROM notifications WHERE (user_id IS NULL) AND is_read=0`);
  return row?.c || 0;
}
async function userUnreadCount(userId) {
  const row = await get(`SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0`, [userId]);
  return row?.c || 0;
}

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  if (req.session.user?.role === "admin") {
    res.locals.adminUnreadCount = await adminUnreadCount();
  } else {
    res.locals.adminUnreadCount = 0;
  }
  if (req.session.user?.id) {
    res.locals.userUnreadCount = await userUnreadCount(req.session.user.id);
  } else {
    res.locals.userUnreadCount = 0;
  }
  next();
});

// ---------- Init DB ----------
initSchema()
  .then(() => console.log("DB ready"))
  .catch((e) => console.error("DB init error", e));

// ---------- Routes ----------

// Home - list properties (pgs)
app.get("/", async (req, res) => {
  try {
    const pgs = await all(`SELECT * FROM properties ORDER BY id DESC`);
    const images = await all(`SELECT * FROM property_images`);
    const imageMap = new Map();
    for (const img of images) {
      if (!imageMap.has(img.property_id)) imageMap.set(img.property_id, []);
      imageMap.get(img.property_id).push(img.filename);
    }
    res.render("index", { pgs, imageMap });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Property detail
app.get("/pg/:id", async (req, res) => {
  try {
    const pg = await get(`SELECT * FROM properties WHERE id=?`, [req.params.id]);
    if (!pg) return res.status(404).send("Not found");
    const images = await all(`SELECT filename FROM property_images WHERE property_id=?`, [pg.id]);
    res.render("property", { pg, images });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Register
app.get("/register", (req, res) => res.render("register", { error: null }));
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.render("register", { error: "All fields required" });

    const existing = await get(`SELECT id FROM users WHERE email=?`, [email.trim().toLowerCase()]);
    if (existing) return res.render("register", { error: "Email already registered" });

    const password_hash = await bcrypt.hash(password, 10);

    // First user becomes admin + approved
    const anyUser = await get(`SELECT id FROM users LIMIT 1`);
    const role = anyUser ? "user" : "admin";
    const status = anyUser ? "pending" : "approved";

    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), password_hash, role, status]
    );

    // Notify admin when new user registers
    if (anyUser) {
      await run(
        `INSERT INTO notifications (user_id, title, message) VALUES (NULL, ?, ?)`,
        ["New user registered", `${name} registered with email ${email}. Approve from Admin > Users.`]
      );
    }

    res.redirect("/login?registered=1");
  } catch (err) {
    console.error(err);
    res.status(500).render("register", { error: "Server error" });
  }
});

// Login
app.get("/login", (req, res) => {
  res.render("login", { error: null, registered: req.query.registered });
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get(`SELECT * FROM users WHERE email=?`, [email.trim().toLowerCase()]);
    if (!user) return res.render("login", { error: "Invalid email or password", registered: null });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.render("login", { error: "Invalid email or password", registered: null });

    if (user.role !== "admin" && user.status !== "approved") {
      return res.render("login", { error: "Your account is pending admin approval", registered: null });
    }

    req.session.user = { id: user.id, name: user.name, role: user.role, email: user.email };
    res.redirect(user.role === "admin" ? "/admin" : "/");
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: "Server error", registered: null });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// User notifications
app.get("/notifications", requireAuth, async (req, res) => {
  const list = await all(`SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC`, [req.session.user.id]);
  await run(`UPDATE notifications SET is_read=1 WHERE user_id=?`, [req.session.user.id]);
  res.render("notifications", { list });
});

// Booking
app.get("/book/:id", requireAuth, async (req, res) => {
  const pg = await get(`SELECT * FROM properties WHERE id=?`, [req.params.id]);
  if (!pg) return res.status(404).send("Not found");
  res.render("book", { pg, error: null });
});

app.post("/book/:id", requireAuth, async (req, res) => {
  try {
    const { checkin, checkout } = req.body;
    const pg = await get(`SELECT * FROM properties WHERE id=?`, [req.params.id]);
    if (!pg) return res.status(404).send("Not found");

    const r = await run(
      `INSERT INTO bookings (user_id, property_id, checkin, checkout) VALUES (?, ?, ?, ?)`,
      [req.session.user.id, pg.id, checkin || "", checkout || ""]
    );

    await run(
      `INSERT INTO notifications (user_id, title, message) VALUES (NULL, ?, ?)`,
      ["New booking request", `Booking #${r.lastID} for PG "${pg.title}" by ${req.session.user.name}`]
    );

    await run(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [req.session.user.id, "Booking created", `Your booking request for "${pg.title}" is submitted.`]
    );

    res.redirect("/my-bookings");
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/my-bookings", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT b.*, p.title, p.price FROM bookings b
     JOIN properties p ON p.id = b.property_id
     WHERE b.user_id=? ORDER BY b.id DESC`,
    [req.session.user.id]
  );
  res.render("my-bookings", { rows });
});

// Payment page (simple UPI settings)
app.get("/pay/:bookingId", requireAuth, async (req, res) => {
  const booking = await get(
    `SELECT b.*, p.title, p.price FROM bookings b
     JOIN properties p ON p.id=b.property_id
     WHERE b.id=? AND b.user_id=?`,
    [req.params.bookingId, req.session.user.id]
  );
  if (!booking) return res.status(404).send("Not found");

  const ps = await get(`SELECT * FROM payment_settings WHERE id=1`);
  res.render("pay", { booking, ps });
});

// ---------- ADMIN ----------
app.get("/admin", requireAdmin, async (req, res) => {
  const totalUsers = await get(`SELECT COUNT(*) as c FROM users`);
  const pendingUsers = await get(`SELECT COUNT(*) as c FROM users WHERE status='pending' AND role='user'`);
  const totalPGs = await get(`SELECT COUNT(*) as c FROM properties`);
  const pendingBookings = await get(`SELECT COUNT(*) as c FROM bookings WHERE status='pending'`);
  res.render("admin", {
    stats: {
      totalUsers: totalUsers.c,
      pendingUsers: pendingUsers.c,
      totalPGs: totalPGs.c,
      pendingBookings: pendingBookings.c
    }
  });
});

// Admin users approve
app.get("/admin/users", requireAdmin, async (req, res) => {
  const users = await all(`SELECT * FROM users ORDER BY id DESC`);
  res.render("admin_users", { users });
});

app.post("/admin/users/:id/approve", requireAdmin, async (req, res) => {
  const user = await get(`SELECT * FROM users WHERE id=?`, [req.params.id]);
  if (!user) return res.redirect("/admin/users");

  await run(`UPDATE users SET status='approved' WHERE id=?`, [user.id]);

  await run(
    `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
    [user.id, "Account approved", "Your account has been approved by admin. You can login now."]
  );

  // Optional email
  try {
    await sendMail({
      to: user.email,
      subject: "RentSpot - Account Approved",
      html: `<p>Hi ${user.name},</p><p>Your account is approved. You can login now.</p>`
    });
  } catch (e) {
    console.error("Email send failed:", e.message);
  }

  res.redirect("/admin/users");
});

// Admin add PG form
app.get("/admin/properties/add", requireAdmin, (req, res) => {
  res.render("admin_property_form", { error: null });
});

// Admin add PG (multiple images)
app.post("/admin/properties/add", requireAdmin, upload.array("images", 6), async (req, res) => {
  try {
    const {
      title, city, area, address, price, description, facilities,
      owner_name, owner_phone, whatsapp_number, location_url
    } = req.body;

    if (!title || !price) return res.render("admin_property_form", { error: "Title and Price required" });

    const r = await run(
      `INSERT INTO properties
      (title, city, area, address, price, description, facilities, owner_name, owner_phone, whatsapp_number, location_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title, city || "", area || "", address || "",
        Number(price || 0),
        description || "", facilities || "",
        owner_name || "", owner_phone || "", whatsapp_number || "", location_url || "",
        req.session.user.id
      ]
    );

    const files = req.files || [];
    for (const f of files) {
      await run(`INSERT INTO property_images (property_id, filename) VALUES (?, ?)`, [r.lastID, f.filename]);
    }

    await run(
      `INSERT INTO notifications (user_id, title, message) VALUES (NULL, ?, ?)`,
      ["New PG added", `Admin added PG "${title}"`]
    );

    res.redirect(`/pg/${r.lastID}`);
  } catch (err) {
    console.error(err);
    res.render("admin_property_form", { error: "Server error while adding PG" });
  }
});

// Admin bookings
app.get("/admin/bookings", requireAdmin, async (req, res) => {
  const rows = await all(
    `SELECT b.*, u.name as user_name, u.email as user_email, p.title as pg_title
     FROM bookings b
     JOIN users u ON u.id=b.user_id
     JOIN properties p ON p.id=b.property_id
     ORDER BY b.id DESC`
  );
  res.render("admin_bookings", { rows });
});

app.post("/admin/bookings/:id/approve", requireAdmin, async (req, res) => {
  const b = await get(`SELECT * FROM bookings WHERE id=?`, [req.params.id]);
  if (!b) return res.redirect("/admin/bookings");

  await run(`UPDATE bookings SET status='approved' WHERE id=?`, [b.id]);

  await run(
    `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
    [b.user_id, "Booking approved", `Your booking #${b.id} is approved.`]
  );
  res.redirect("/admin/bookings");
});

app.post("/admin/bookings/:id/reject", requireAdmin, async (req, res) => {
  const b = await get(`SELECT * FROM bookings WHERE id=?`, [req.params.id]);
  if (!b) return res.redirect("/admin/bookings");

  await run(`UPDATE bookings SET status='rejected' WHERE id=?`, [b.id]);

  await run(
    `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
    [b.user_id, "Booking rejected", `Your booking #${b.id} is rejected.`]
  );
  res.redirect("/admin/bookings");
});

// Payment settings
app.get("/admin/payment", requireAdmin, async (req, res) => {
  const ps = await get(`SELECT * FROM payment_settings WHERE id=1`);
  res.render("admin_payment", { ps, saved: req.query.saved });
});

app.post("/admin/payment", requireAdmin, async (req, res) => {
  const { upi_id, payee_name, note } = req.body;
  await run(`UPDATE payment_settings SET upi_id=?, payee_name=?, note=? WHERE id=1`, [upi_id || "", payee_name || "", note || ""]);
  res.redirect("/admin/payment?saved=1");
});

// Admin notifications (system)
app.get("/admin/notifications", requireAdmin, async (req, res) => {
  const list = await all(`SELECT * FROM notifications WHERE user_id IS NULL ORDER BY id DESC`);
  await run(`UPDATE notifications SET is_read=1 WHERE user_id IS NULL`);
  res.render("admin_notifications", { list });
});

// Admin message broadcast (store + optional email)
app.get("/admin/message", requireAdmin, (req, res) => {
  res.render("admin_message", { sent: null, error: null });
});

app.post("/admin/message", requireAdmin, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.render("admin_message", { sent: null, error: "Title & message required" });

    const users = await all(`SELECT * FROM users WHERE role='user' AND status='approved'`);
    for (const u of users) {
      await run(`INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`, [u.id, title, message]);

      try {
        await sendMail({
          to: u.email,
          subject: `RentSpot: ${title}`,
          html: `<p>${message}</p>`
        });
      } catch (e) {
        // ignore email failure
      }
    }
    res.render("admin_message", { sent: "Sent to all approved users", error: null });
  } catch (err) {
    console.error(err);
    res.render("admin_message", { sent: null, error: "Server error" });
  }
});

// Simple messages page (for user)
app.get("/messages", requireAuth, async (req, res) => {
  const list = await all(`SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC`, [req.session.user.id]);
  res.render("messages", { list });
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Global error
app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  res.status(500).send("Internal Server Error");
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));