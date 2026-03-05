// server.js (SQLite + password_hash FIX + safe init)
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

// Try dotenv (if module missing, app won't crash)
try {
  require("dotenv").config();
} catch (e) {
  // ignore
}

const { initSchema, run, get, all } = require("./database");

const app = express();

// ---------- App config ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || "rentspot_secret_change_me",
    resave: false,
    saveUninitialized: false,
  })
);

// Make user available in EJS
app.use(async (req, res, next) => {
  res.locals.me = req.session.user || null;

  // unread notifications count
  if (req.session?.user?.email) {
    try {
      const row = await get(
        "SELECT COUNT(*) AS c FROM notifications WHERE recipient=? AND is_read=0",
        [req.session.user.email]
      );
      res.locals.unreadCount = row ? row.c : 0;
    } catch (e) {
      res.locals.unreadCount = 0;
    }
  } else {
    res.locals.unreadCount = 0;
  }

  next();
});

// ---------- DB init (VERY IMPORTANT) ----------
initSchema()
  .then(() => console.log("✅ DB schema ready"))
  .catch((e) => console.error("❌ DB schema init error:", e));

// ---------- Upload (PG photos) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") return res.redirect("/login");
  next();
}

// Notifications helper
async function notify(recipient, title, message, link = "") {
  try {
    await run(
      "INSERT INTO notifications (recipient, title, message, link, is_read) VALUES (?,?,?,?,0)",
      [recipient, title, message, link]
    );
  } catch (e) {
    console.log("notify error ignored:", e.message);
  }
}

// ---------- Routes ----------

// Home: list PGs
app.get("/", async (req, res) => {
  try {
    const pgs = await all(`
      SELECT p.*,
        COALESCE((SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.pg_id=p.id), 0) AS avg_rating,
        COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.pg_id=p.id), 0) AS review_count
      FROM pgs p
      ORDER BY p.id DESC
    `);

    // if you have index.ejs from your project, it will render
    return res.render("index", { pgs });
  } catch (e) {
    console.error(e);
    return res.send("Home error: " + e.message);
  }
});

// PG detail
app.get("/pg/:id", async (req, res) => {
  try {
    const pgId = Number(req.params.id);
    const pg = await get("SELECT * FROM pgs WHERE id=?", [pgId]);
    if (!pg) return res.status(404).send("PG not found");

    const photos = await all("SELECT * FROM pg_photos WHERE pg_id=? ORDER BY id ASC", [pgId]);

    const reviews = await all(
      `SELECT rv.*, u.name AS user_name
       FROM reviews rv
       JOIN users u ON u.id=rv.user_id
       WHERE rv.pg_id=?
       ORDER BY rv.id DESC`,
      [pgId]
    );

    const stats = await get(
      `SELECT COALESCE(ROUND(AVG(rating),2),0) AS avg_rating,
              COALESCE(COUNT(*),0) AS cnt
       FROM reviews
       WHERE pg_id=?`,
      [pgId]
    );

    return res.render("pg_detail", { pg, photos, reviews, stats });
  } catch (e) {
    console.error(e);
    return res.send("PG view error: " + e.message);
  }
});

// -------- Reviews --------
app.post("/pg/:id/review", requireLogin, async (req, res) => {
  try {
    const pgId = Number(req.params.id);
    const rating = Number(req.body.rating || 0);
    const comment = (req.body.comment || "").trim();

    if (rating < 1 || rating > 5) return res.redirect("/pg/" + pgId);

    await run(
      "INSERT INTO reviews (pg_id, user_id, rating, comment) VALUES (?,?,?,?)",
      [pgId, req.session.user.id, rating, comment]
    );

    await notify(req.session.user.email, "Review submitted", "Your review is saved ✅", "/pg/" + pgId);
    await notify("admin", "New Review", `New review by ${req.session.user.email}`, "/pg/" + pgId);

    res.redirect("/pg/" + pgId);
  } catch (e) {
    console.error(e);
    res.redirect("/pg/" + req.params.id);
  }
});

// -------- Booking --------
app.post("/pg/:id/book", requireLogin, async (req, res) => {
  try {
    const pgId = Number(req.params.id);
    const message = (req.body.message || "").trim();

    await run(
      "INSERT INTO bookings (pg_id, user_id, message, status) VALUES (?,?,?,?)",
      [pgId, req.session.user.id, message, "pending"]
    );

    await notify(req.session.user.email, "Booking request sent", "Admin will contact you soon.", "/pg/" + pgId);
    await notify("admin", "New Booking Request", `Booking request by ${req.session.user.email}`, "/admin/bookings");

    res.redirect("/pg/" + pgId);
  } catch (e) {
    console.error(e);
    res.redirect("/pg/" + req.params.id);
  }
});

// -------- Admin: Add PG --------
app.get("/admin/pg/add", requireAdmin, (req, res) => {
  res.render("pg_add", { error: null });
});

app.post("/admin/pg/add", requireAdmin, upload.array("photos", 10), async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    const city = (req.body.city || "").trim();
    const address = (req.body.address || "").trim();
    const price = Number(req.body.price || 0);
    const phone = (req.body.phone || "").trim();
    const description = (req.body.description || "").trim();

    if (!title || !city || !price) {
      return res.render("pg_add", { error: "Title, city, price required" });
    }

    const result = await run(
      "INSERT INTO pgs (title, city, address, price, phone, description, created_by) VALUES (?,?,?,?,?,?,?)",
      [title, city, address, price, phone, description, req.session.user.id]
    );
    const pgId = result.lastID;

    const files = req.files || [];
    for (const f of files) {
      await run("INSERT INTO pg_photos (pg_id, file_path) VALUES (?,?)", [pgId, "/uploads/" + f.filename]);
    }

    await notify("admin", "New PG added", `PG "${title}" added`, "/pg/" + pgId);

    res.redirect("/pg/" + pgId);
  } catch (e) {
    console.error(e);
    res.render("pg_add", { error: "Server error while adding PG" });
  }
});

// Admin bookings list
app.get("/admin/bookings", requireAdmin, async (req, res) => {
  try {
    const bookings = await all(
      `SELECT b.*,
              u.email AS user_email,
              p.title AS pg_title
       FROM bookings b
       JOIN users u ON u.id=b.user_id
       JOIN pgs p ON p.id=b.pg_id
       ORDER BY b.id DESC`
    );
    res.render("admin_bookings", { bookings });
  } catch (e) {
    console.error(e);
    res.send("Admin bookings error: " + e.message);
  }
});

// -------- Notifications --------
app.get("/notifications", requireLogin, async (req, res) => {
  try {
    const items = await all(
      "SELECT * FROM notifications WHERE recipient=? ORDER BY id DESC LIMIT 200",
      [req.session.user.email]
    );
    res.render("notifications", { items });
  } catch (e) {
    console.error(e);
    res.send("Notifications error: " + e.message);
  }
});

app.post("/notifications/read-all", requireLogin, async (req, res) => {
  try {
    await run("UPDATE notifications SET is_read=1 WHERE recipient=?", [req.session.user.email]);
  } catch (e) {
    console.log(e.message);
  }
  res.redirect("/notifications");
});

// Admin notifications (optional page)
app.get("/admin/notifications", requireAdmin, async (req, res) => {
  try {
    const items = await all("SELECT * FROM notifications WHERE recipient='admin' ORDER BY id DESC LIMIT 500");
    res.render("admin_notifications", { items });
  } catch (e) {
    console.error(e);
    res.send("Admin notifications error: " + e.message);
  }
});

// -------- Auth --------

// Register
app.get("/register", (req, res) => {
  res.render("register", { error: null, success: null });
});

app.post("/register", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    if (!name || !email || !password) {
      return res.render("register", { error: "All fields are required", success: null });
    }
    if (password.length < 6) {
      return res.render("register", { error: "Password must be at least 6 characters", success: null });
    }

    const existing = await get("SELECT id FROM users WHERE email=?", [email]);
    if (existing) {
      return res.render("register", { error: "Email already registered", success: null });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // First user -> admin
    const row = await get("SELECT COUNT(*) AS count FROM users", []);
    const role = row && row.count === 0 ? "admin" : "user";

    // ✅ IMPORTANT: password_hash
    await run(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
      [name, email, passwordHash, role]
    );

    await notify(email, "Welcome", "Your account has been created ✅", "/login");

    return res.render("register", { error: null, success: "Account created ✅ Now login." });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res.render("register", { error: "Server error", success: null });
  }
});

// Login
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = (req.body.password || "").trim();

    const user = await get("SELECT * FROM users WHERE email=?", [email]);
    if (!user) return res.render("login", { error: "Invalid email or password" });

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) return res.render("login", { error: "Invalid email or password" });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    await notify(user.email, "Login successful", "You are logged in ✅", "/");

    res.redirect("/");
  } catch (e) {
    console.error("LOGIN ERROR:", e);
    res.render("login", { error: "Server error" });
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ RentSpot running on port", PORT));