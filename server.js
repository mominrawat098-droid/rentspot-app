// server.js (PASTE-READY)
// RentSpot - Express + EJS + SQLite
// Fixes:
// 1) Register uses password_hash
// 2) EJS nav errors fixed (adminUnreadCount/userUnreadCount always defined)

const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

// Your database helper (must exist in project root)
const { db, run, get, all, initSchema } = require("./database");

const app = express();

// ---------- Basic Config ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Render/Production: trust proxy (cookies/session stable)
app.set("trust proxy", 1);

// ---------- Session ----------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "rentspot_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true only if you force https + proxy settings
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// ---------- Init DB Schema ----------
(async () => {
  try {
    if (typeof initSchema === "function") {
      await initSchema();
    } else {
      // If your database.js doesn't export initSchema, we still try to ensure tables here:
      await run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS properties (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          city TEXT,
          address TEXT,
          price INTEGER DEFAULT 0,
          description TEXT,
          image TEXT,
          owner_phone TEXT,
          location_url TEXT,
          created_by INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          property_id INTEGER NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          property_id INTEGER NOT NULL,
          rating INTEGER NOT NULL,
          comment TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          admin_only INTEGER DEFAULT 0,
          title TEXT,
          message TEXT,
          is_read INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    console.log("✅ Database schema ready");
  } catch (e) {
    console.error("❌ DB init error:", e);
  }
})();

// ---------- Helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role !== "admin") return res.status(403).send("Forbidden");
  next();
}

// Always provide nav variables to EJS to avoid crashes
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;

  // ✅ These MUST always exist (fixes: adminUnreadCount is not defined)
  res.locals.adminUnreadCount = 0;
  res.locals.userUnreadCount = 0;

  try {
    // If notifications table exists, compute counts
    if (req.session.user?.role === "admin") {
      const row = await get(
        `SELECT COUNT(*) as c FROM notifications WHERE admin_only=1 AND is_read=0`
      );
      res.locals.adminUnreadCount = row?.c || 0;
    }

    if (req.session.user?.id) {
      const row2 = await get(
        `SELECT COUNT(*) as c FROM notifications WHERE admin_only=0 AND user_id=? AND is_read=0`,
        [req.session.user.id]
      );
      res.locals.userUnreadCount = row2?.c || 0;
    }
  } catch (e) {
    // if table missing etc, keep counts 0 (no crash)
  }

  next();
});

// ---------- Routes ----------

// Home (property list)
app.get("/", async (req, res, next) => {
  try {
    const properties = await all(
      `SELECT * FROM properties ORDER BY id DESC LIMIT 100`
    );
    // Use index.ejs if you have it
    return res.render("index", { properties });
  } catch (e) {
    return next(e);
  }
});

// Register
app.get("/register", (req, res) => {
  return res.render("register", { error: null });
});

app.post("/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).render("register", { error: "All fields required" });
    }

    const existing = await get(`SELECT id FROM users WHERE email=?`, [email.trim()]);
    if (existing) {
      return res.status(400).render("register", { error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // ✅ IMPORTANT: password_hash column
    await run(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), passwordHash, "user"]
    );

    // First user becomes admin (optional rule from your UI note)
    const count = await get(`SELECT COUNT(*) as c FROM users`);
    if (count?.c === 1) {
      await run(`UPDATE users SET role='admin' WHERE email=?`, [email.trim().toLowerCase()]);
    }

    return res.redirect("/login");
  } catch (e) {
    return next(e);
  }
});

// Login
app.get("/login", (req, res) => {
  return res.render("login", { error: null });
});

app.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).render("login", { error: "Email & password required" });
    }

    const user = await get(`SELECT * FROM users WHERE email=?`, [email.trim().toLowerCase()]);
    if (!user) return res.status(401).render("login", { error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).render("login", { error: "Invalid credentials" });

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    return res.redirect("/");
  } catch (e) {
    return next(e);
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Property detail (pg_detail.ejs)
app.get("/pg/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pg = await get(`SELECT * FROM properties WHERE id=?`, [id]);
    if (!pg) return res.status(404).send("Not found");

    const reviews = await all(
      `SELECT r.*, u.name as user_name
       FROM reviews r
       JOIN users u ON u.id=r.user_id
       WHERE r.property_id=?
       ORDER BY r.id DESC`,
      [id]
    );

    const avgRow = await get(
      `SELECT AVG(rating) as avgRating, COUNT(*) as total FROM reviews WHERE property_id=?`,
      [id]
    );

    return res.render("pg_detail", {
      pg,
      reviews,
      avgRating: avgRow?.avgRating ? Number(avgRow.avgRating).toFixed(1) : "0.0",
      totalReviews: avgRow?.total || 0,
      error: null,
    });
  } catch (e) {
    return next(e);
  }
});

// Add review
app.post("/pg/:id/review", requireLogin, async (req, res, next) => {
  try {
    const property_id = Number(req.params.id);
    const rating = Number(req.body.rating);
    const comment = (req.body.comment || "").trim();

    if (!rating || rating < 1 || rating > 5) {
      return res.redirect(`/pg/${property_id}`);
    }

    await run(
      `INSERT INTO reviews (user_id, property_id, rating, comment) VALUES (?, ?, ?, ?)`,
      [req.session.user.id, property_id, rating, comment]
    );

    // Optional notification to admin
    await run(
      `INSERT INTO notifications (admin_only, title, message, is_read) VALUES (1, ?, ?, 0)`,
      ["New Review", `New review posted on property #${property_id}`]
    );

    return res.redirect(`/pg/${property_id}`);
  } catch (e) {
    return next(e);
  }
});

// Booking
app.post("/pg/:id/book", requireLogin, async (req, res, next) => {
  try {
    const property_id = Number(req.params.id);
    await run(
      `INSERT INTO bookings (user_id, property_id, status) VALUES (?, ?, ?)`,
      [req.session.user.id, property_id, "pending"]
    );

    await run(
      `INSERT INTO notifications (admin_only, title, message, is_read) VALUES (1, ?, ?, 0)`,
      ["New Booking", `New booking request for property #${property_id}`]
    );

    return res.redirect("/my-bookings");
  } catch (e) {
    return next(e);
  }
});

// My bookings page (my-booking.ejs)
app.get("/my-bookings", requireLogin, async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT b.*, p.title as property_title, p.city, p.price
       FROM bookings b
       JOIN properties p ON p.id=b.property_id
       WHERE b.user_id=?
       ORDER BY b.id DESC`,
      [req.session.user.id]
    );
    return res.render("my-booking", { bookings: rows });
  } catch (e) {
    return next(e);
  }
});

// Admin: add property page (pg_add.ejs)
app.get("/admin/properties/add", requireAdmin, (req, res) => {
  return res.render("pg_add", { error: null });
});

// Admin: create property (simple, without file upload)
app.post("/admin/properties/add", requireAdmin, async (req, res, next) => {
  try {
    const { title, city, address, price, description, image, owner_phone, location_url } = req.body;

    if (!title) return res.status(400).render("pg_add", { error: "Title required" });

    await run(
      `INSERT INTO properties (title, city, address, price, description, image, owner_phone, location_url, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        (title || "").trim(),
        (city || "").trim(),
        (address || "").trim(),
        Number(price || 0),
        (description || "").trim(),
        (image || "").trim(),
        (owner_phone || "").trim(),
        (location_url || "").trim(),
        req.session.user.id,
      ]
    );

    return res.redirect("/");
  } catch (e) {
    return next(e);
  }
});

// Notifications page (notifications.ejs)
app.get("/notifications", requireLogin, async (req, res, next) => {
  try {
    const notes = await all(
      `SELECT * FROM notifications
       WHERE admin_only=0 AND user_id=?
       ORDER BY id DESC LIMIT 200`,
      [req.session.user.id]
    );

    // mark read
    await run(
      `UPDATE notifications SET is_read=1 WHERE admin_only=0 AND user_id=?`,
      [req.session.user.id]
    );

    return res.render("notifications", { notifications: notes });
  } catch (e) {
    return next(e);
  }
});

// Admin notifications (admin_notifications.ejs)
app.get("/admin/notifications", requireAdmin, async (req, res, next) => {
  try {
    const notes = await all(
      `SELECT * FROM notifications WHERE admin_only=1 ORDER BY id DESC LIMIT 200`
    );
    await run(`UPDATE notifications SET is_read=1 WHERE admin_only=1`);
    return res.render("admin_notifications", { notifications: notes });
  } catch (e) {
    return next(e);
  }
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Error Handler ----------
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);

  // Show simple page for users
  res.status(500).send("Internal Server Error");
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});