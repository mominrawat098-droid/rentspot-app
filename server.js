// server.js
const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const db = require("./database");
const {
  notifyUser,
  notifyAdmin,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead
} = require("./notifications");

const app = express();

// ====== BASIC CONFIG ======
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static folders
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Sessions
app.use(
  session({
    secret: process.env.SESSION_SECRET || "rentspot_secret_change_me",
    resave: false,
    saveUninitialized: false
  })
);

// ====== MULTER (multiple photos) ======
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: function (req, file, cb) {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ====== AUTH HELPERS ======
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).send("Forbidden");
  }
  next();
}

// ====== GLOBAL NOTIFICATION COUNT (for header) ======
app.use(async (req, res, next) => {
  try {
    res.locals.me = req.session.user || null;

    res.locals.unreadCount = 0;
    res.locals.adminUnreadCount = 0;

    if (req.session?.user?.email) {
      res.locals.unreadCount = await getUnreadCount(req.session.user.email);
    }
    if (req.session?.user?.role === "admin") {
      res.locals.adminUnreadCount = await getUnreadCount("admin");
    }
    next();
  } catch (e) {
    console.error("Notif middleware:", e.message);
    next();
  }
});

// ====== ROUTES ======

// Home: list PGs
app.get("/", async (req, res) => {
  const pgs = await db.allAsync(`
    SELECT p.*,
      (SELECT AVG(rating) FROM reviews WHERE pg_id = p.id) as avg_rating,
      (SELECT COUNT(*) FROM reviews WHERE pg_id = p.id) as review_count
    FROM pgs p
    ORDER BY datetime(p.created_at) DESC
  `);
  res.render("index", { pgs });
});

// PG Details
app.get("/pg/:id", async (req, res) => {
  const id = Number(req.params.id);
  const pg = await db.getAsync(`SELECT * FROM pgs WHERE id = ?`, [id]);
  if (!pg) return res.status(404).send("PG not found");

  const photos = await db.allAsync(`SELECT * FROM pg_photos WHERE pg_id = ?`, [id]);
  const reviews = await db.allAsync(`
    SELECT rv.*, u.name as user_name
    FROM reviews rv
    JOIN users u ON u.id = rv.user_id
    WHERE rv.pg_id = ?
    ORDER BY datetime(rv.created_at) DESC
  `, [id]);

  const stats = await db.getAsync(`
    SELECT
      ROUND(AVG(rating), 2) as avg_rating,
      COUNT(*) as cnt
    FROM reviews
    WHERE pg_id = ?
  `, [id]);

  res.render("pg_detail", { pg, photos, reviews, stats });
});

// Add PG (admin)
app.get("/admin/pg/add", requireAdmin, (req, res) => {
  res.render("pg_add", { error: null });
});

// Add PG (POST) multiple photos
app.post("/admin/pg/add", requireAdmin, upload.array("photos", 10), async (req, res) => {
  try {
    const { title, city, address, price, phone, description } = req.body;
    if (!title || !city || !price) {
      return res.render("pg_add", { error: "Title, city, price required" });
    }

    const result = await db.runAsync(
      `INSERT INTO pgs (title, city, address, price, phone, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title, city, address || "", Number(price), phone || "", description || "", req.session.user.id]
    );

    const pgId = result.lastID;

    // Save photos
    const files = req.files || [];
    for (const f of files) {
      await db.runAsync(`INSERT INTO pg_photos (pg_id, file_path) VALUES (?, ?)`, [
        pgId,
        "/uploads/" + f.filename
      ]);
    }

    // Notifications
    await notifyAdmin({
      title: "New PG added",
      message: `PG "${title}" added by admin ${req.session.user.email}`,
      link: `/pg/${pgId}`
    });

    res.redirect(`/pg/${pgId}`);
  } catch (e) {
    console.error(e);
    res.render("pg_add", { error: "Server error while adding PG" });
  }
});

// Review submit (user)
app.post("/pg/:id/review", requireLogin, async (req, res) => {
  try {
    const pgId = Number(req.params.id);
    const rating = Number(req.body.rating || 0);
    const comment = (req.body.comment || "").trim();

    if (rating < 1 || rating > 5) return res.redirect(`/pg/${pgId}`);

    // Insert review
    await db.runAsync(
      `INSERT INTO reviews (pg_id, user_id, rating, comment) VALUES (?, ?, ?, ?)`,
      [pgId, req.session.user.id, rating, comment]
    );

    // Notify admin
    await notifyAdmin({
      title: "New Review",
      message: `User ${req.session.user.email} added a review on PG #${pgId}`,
      link: `/pg/${pgId}`
    });

    // Notify user
    await notifyUser({
      recipientEmail: req.session.user.email,
      title: "Review submitted",
      message: "Thanks! Your review has been saved successfully.",
      link: `/pg/${pgId}`
    });

    res.redirect(`/pg/${pgId}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/pg/${req.params.id}`);
  }
});

// Booking request (user)
app.post("/pg/:id/book", requireLogin, async (req, res) => {
  try {
    const pgId = Number(req.params.id);
    const message = (req.body.message || "").trim();

    await db.runAsync(
      `INSERT INTO bookings (pg_id, user_id, message, status) VALUES (?, ?, ?, 'pending')`,
      [pgId, req.session.user.id, message]
    );

    await notifyAdmin({
      title: "New Booking Request",
      message: `Booking request by ${req.session.user.email} for PG #${pgId}`,
      link: `/admin/bookings`
    });

    await notifyUser({
      recipientEmail: req.session.user.email,
      title: "Booking request sent",
      message: "Your booking request has been submitted. Admin will contact you.",
      link: `/pg/${pgId}`
    });

    res.redirect(`/pg/${pgId}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/pg/${req.params.id}`);
  }
});

// Admin bookings view
app.get("/admin/bookings", requireAdmin, async (req, res) => {
  const bookings = await db.allAsync(`
    SELECT b.*, u.email as user_email, p.title as pg_title
    FROM bookings b
    JOIN users u ON u.id = b.user_id
    JOIN pgs p ON p.id = b.pg_id
    ORDER BY datetime(b.created_at) DESC
  `);
  res.render("admin_bookings", { bookings });
});

// ===== Notifications pages =====
app.get("/notifications", requireLogin, async (req, res) => {
  const items = await getNotifications(req.session.user.email, 200);
  res.render("notifications", { items });
});

app.post("/notifications/:id/read", requireLogin, async (req, res) => {
  await markRead(req.session.user.email, Number(req.params.id));
  res.redirect("/notifications");
});

app.post("/notifications/read-all", requireLogin, async (req, res) => {
  await markAllRead(req.session.user.email);
  res.redirect("/notifications");
});

// Admin notifications
app.get("/admin/notifications", requireAdmin, async (req, res) => {
  const items = await getNotifications("admin", 500);
  res.render("admin_notifications", { items });
});

app.post("/admin/notifications/read-all", requireAdmin, async (req, res) => {
  await markAllRead("admin");
  res.redirect("/admin/notifications");
});

// ===== Auth =====
app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    if (!name || !email || password.length < 4) {
      return res.render("register", { error: "Fill all fields (password min 4)" });
    }

    const exist = await db.getAsync(`SELECT * FROM users WHERE email = ?`, [email]);
    if (exist) return res.render("register", { error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);

    // First user becomes admin (easy for college project)
    const total = await db.getAsync(`SELECT COUNT(*) as c FROM users`);
    const role = total?.c === 0 ? "admin" : "user";

    const result = await db.runAsync(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [name, email, hash, role]
    );

    req.session.user = { id: result.lastID, name, email, role };

    await notifyUser({
      recipientEmail: email,
      title: "Welcome to RentSpot",
      message: "Your account has been created successfully.",
      link: "/"
    });

    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.render("register", { error: "Server error" });
  }
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    const user = await db.getAsync(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) return res.render("login", { error: "Invalid email/password" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.render("login", { error: "Invalid email/password" });

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };

    await notifyUser({
      recipientEmail: user.email,
      title: "Login successful",
      message: "You are logged in.",
      link: "/"
    });

    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.render("login", { error: "Server error" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("RentSpot running on port", PORT);
});