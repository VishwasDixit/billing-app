// Sends OTP emails through Gmail (free, ~500/day) with an App Password.
// Needs GMAIL_USER and GMAIL_APP_PASSWORD. In local development (OTP_DEV_LOG=1)
// codes are printed to the server log instead. Tests can plug in their own transport.
import nodemailer from "nodemailer";

let transport = null;
let testTransport = null;

export function setTestTransport(fn) {
  testTransport = fn;
}

const gmailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

export const emailOtpEnabled = () => gmailConfigured() || !!testTransport || process.env.OTP_DEV_LOG === "1";

const PURPOSE = {
  register: { subject: "Verify your email", title: "Verify your email", line: "Use this code to finish creating your shop account." },
  login: { subject: "Your login code", title: "Your login code", line: "Use this code to log in." },
  reset: { subject: "Reset your password", title: "Reset your password", line: "Use this code to set a new password." },
};

export function otpEmail({ code, purpose, appName = "Billing" }) {
  const p = PURPOSE[purpose] || PURPOSE.login;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = `${p.title}\n\n${p.line}\n\n${spaced}\n\nThe code is valid for 10 minutes. If you didn't ask for it, you can ignore this email.\n\n— ${appName}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2025">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#fff;border-radius:14px;border:1px solid #e3e5e9">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:700">${p.title}</td></tr>
<tr><td style="padding:0 28px 18px;color:#6b7280;font-size:15px">${p.line}</td></tr>
<tr><td align="center" style="padding:6px 28px 22px"><div style="display:inline-block;background:#e6f4f2;color:#0f766e;font-size:34px;font-weight:800;letter-spacing:8px;padding:14px 22px;border-radius:12px;font-family:Menlo,Consolas,monospace">${spaced}</div></td></tr>
<tr><td style="padding:0 28px 26px;color:#6b7280;font-size:13px">The code is valid for 10 minutes. If you didn't ask for it, you can ignore this email.</td></tr>
</table><div style="color:#9aa0a6;font-size:12px;padding-top:14px">${appName}</div></td></tr></table></body></html>`;
  return { subject: `${code} is your ${p.subject.toLowerCase()} code`, text, html };
}

// Checks the Gmail login without sending anything (used by /api/health?check=gmail).
export async function verifyGmail() {
  if (!gmailConfigured()) return "not set";
  try {
    await gmailTransport().verify();
    return "ok";
  } catch (err) {
    return "error: " + String(err?.response || err?.message || err).slice(0, 160);
  }
}

function gmailTransport() {
  transport ||= nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") },
  });
  return transport;
}

export async function sendOtpEmail({ to, code, purpose, appName }) {
  const msg = otpEmail({ code, purpose, appName });
  if (testTransport) return testTransport({ to, code, purpose, ...msg });
  if (!gmailConfigured()) {
    if (process.env.OTP_DEV_LOG === "1") {
      console.log(`[dev email] to=${to} purpose=${purpose} code=${code}`);
      return;
    }
    throw new Error("Email sending is not set up (GMAIL_USER / GMAIL_APP_PASSWORD).");
  }
  await gmailTransport().sendMail({ from: `"${appName || "Billing"}" <${process.env.GMAIL_USER}>`, to, subject: msg.subject, text: msg.text, html: msg.html });
}
