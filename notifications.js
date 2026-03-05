// notifications.js
const nodemailer = require("nodemailer");
const db = require("./database");

async function createNotification({ recipient, title, message, link = null }) {
  await db.runAsync(
    `INSERT INTO notifications (recipient, title, message, link, is_read) VALUES (?, ?, ?, ?, 0)`,
    [recipient, title, message, link]
  );
}

async function getNotifications(recipient, limit = 50) {
  return db.allAsync(
    `SELECT * FROM notifications WHERE recipient = ? ORDER BY datetime(created_at) DESC LIMIT ?`,
    [recipient, limit]
  );
}

async function getUnreadCount(recipient) {
  const row = await db.getAsync(
    `SELECT COUNT(*) as cnt FROM notifications WHERE recipient = ? AND is_read = 0`,
    [recipient]
  );
  return row?.cnt || 0;
}

async function markRead(recipient, id) {
  await db.runAsync(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient = ?`,
    [id, recipient]
  );
}

async function markAllRead(recipient) {
  await db.runAsync(
    `UPDATE notifications SET is_read = 1 WHERE recipient = ?`,
    [recipient]
  );
}

// Email: SAFE mode (SMTP missing => skip, no crash)
function smtpEnabled() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendEmailSafe({ to, subject, text }) {
  if (!smtpEnabled()) return { skipped: true };

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });

  return { sent: true };
}

async function notifyUser({ recipientEmail, title, message, link }) {
  await createNotification({ recipient: recipientEmail, title, message, link });
  try {
    await sendEmailSafe({
      to: recipientEmail,
      subject: `RentSpot: ${title}`,
      text: `${message}${link ? `\n\nOpen: ${link}` : ""}`
    });
  } catch (e) {
    console.error("Email failed (ignored):", e.message);
  }
}

async function notifyAdmin({ title, message, link }) {
  await createNotification({ recipient: "admin", title, message, link });

  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    try {
      await sendEmailSafe({
        to: adminEmail,
        subject: `RentSpot Admin: ${title}`,
        text: `${message}${link ? `\n\nOpen: ${link}` : ""}`
      });
    } catch (e) {
      console.error("Admin email failed (ignored):", e.message);
    }
  }
}

module.exports = {
  notifyUser,
  notifyAdmin,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead
};