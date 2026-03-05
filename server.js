// server.js
const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const { run, get, all, initSchema } = require("./database");

const app = express();
const PORT = process.env.PORT || 10000;

// ---- View + Static ----
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/public", express.static(path.join(__dirname, "public")));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Session ----
app.use(
  session({
    secret: process.env.SESSION_SECRET || "rentspot_secret_key_change_me",
    resave: false,
    saveUninitialized: false,
  })
);

// ---- Multer Uploads ----
const uploadDir = path.join(__dirname, "public", "uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, safe);
  },
});
const upload = multer({ storage });

// ---- Global locals (EJS errors fix) ----
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;

  // ye variables agar views me use ho rahe ho to undefined nahi honge
  res.locals.adminUnreadCount = 0;
  res.locals.unreadCount = 0;

  next();
});

// ---- Helpers ----
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

// ---- ROUTES ----

// Home (IMPORTANT: index.ejs expects "pgs")
app.get("/", async (req, res) => {
  try {
    const pgs = await all("SELECT * FROM properties ORDER BY id DESC");
    res.render("index", { pgs });
  } catch (e) {
    console.error("HOME ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Register
app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.render("register", { error: "All fields are required." });
    }

    const existing = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.render("register", { error: "Email already exists." });
    }

    const usersCountRow = await get("SELECT COUNT(*) as c FROM users");
    const firstUser = (usersCountRow?.c || 0) === 0;
    const role = firstUser ? "admin" : "user";

    const passwordHash = await bcrypt.hash(password, 10);

    // IMPORTANT: password_hash column used
    await run(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, passwordHash, role]
    );

    return res.redirect("/login");
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res.status(500).render("register", { error: "Server error" });
  }
});

// Login
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return res.render("login", { error: "Invalid email or password" });

    // user.password_hash missing ho to login fail (old users)
    if (!user.password_hash) {
      return res.render("login", { error: "Account needs re-registration (old DB)." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.render("login", { error: "Invalid email or password" });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    res.redirect("/");
  } catch (e) {
    console.error("LOGIN ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ---- Admin: Add PG ----
app.get("/pg/add", requireAdmin, (req, res) => {
  res.render("pg_add", { error: null });
});

app.post("/pg/add", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { title, city, address, price, description, owner_phone, whatsapp, location_url } = req.body;

    const image = req.file ? `/public/uploads/${req.file.filename}` : null;

    await run(
      `INSERT INTO properties (title, city, address, price, description, image, owner_phone, whatsapp, location_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, city, address, Number(price || 0), description, image, owner_phone, whatsapp, location_url]
    );

    res.redirect("/");
  } catch (e) {
    console.error("ADD PG ERROR:", e);
    res.status(500).render("pg_add", { error: "Server error while adding PG." });
  }
});

// PG Detail
app.get("/pg/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pg = await get("SELECT * FROM properties WHERE id = ?", [id]);
    if (!pg) return res.status(404).send("Not Found");

    const reviews = await all(
      "SELECT * FROM reviews WHERE property_id = ? ORDER BY id DESC",
      [id]
    );

    res.render("pg_detail", { pg, reviews, error: null });
  } catch (e) {
    console.error("PG DETAIL ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Add Review
app.post("/pg/:id/review", requireLogin, async (req, res) => {
  try {
    const property_id = Number(req.params.id);
    const rating = Number(req.body.rating || 0);
    const comment = (req.body.comment || "").trim();

    if (rating < 1 || rating > 5) return res.redirect(`/pg/${property_id}`);

    await run(
      `INSERT INTO reviews (property_id, user_id, user_name, rating, comment)
       VALUES (?, ?, ?, ?, ?)`,
      [property_id, req.session.user.id, req.session.user.name, rating, comment]
    );

    res.redirect(`/pg/${property_id}`);
  } catch (e) {
    console.error("REVIEW ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Booking
app.post("/book/:id", requireLogin, async (req, res) => {
  try {
    const property_id = Number(req.params.id);

    const pg = await get("SELECT * FROM properties WHERE id = ?", [property_id]);
    if (!pg) return res.status(404).send("Not Found");

    await run(
      `INSERT INTO bookings (property_id, user_id, user_name, user_email, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [property_id, req.session.user.id, req.session.user.name, req.session.user.email]
    );

    // user notification (simple)
    await run(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [req.session.user.id, "Booking Requested", `Your booking request for "${pg.title}" is submitted.`]
    );

    res.redirect("/my-bookings");
  } catch (e) {
    console.error("BOOK ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/my-bookings", requireLogin, async (req, res) => {
  try {
    const rows = await all(
      `SELECT b.*, p.title, p.city, p.price
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       WHERE b.user_id = ?
       ORDER BY b.id DESC`,
      [req.session.user.id]
    );

    res.render("my-bookings", { bookings: rows });
  } catch (e) {
    console.error("MY BOOKINGS ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Notifications page
app.get("/notifications", requireLogin, async (req, res) => {
  try {
    const items = await all(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC`,
      [req.session.user.id]
    );

    // mark read
    await run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`, [req.session.user.id]);

    res.render("notifications", { notifications: items });
  } catch (e) {
    console.error("NOTIFICATIONS ERROR:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- Start ----
(async () => {
  try {
    await initSchema();
    app.listen(PORT, () => console.log("Server running on port", PORT));
  } catch (e) {
    console.error("INIT ERROR:", e);
    process.exit(1);
  }
})();