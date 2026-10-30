import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { fmtDateTime } from "../lib/format.js";
import { Field, useAction, useToast } from "../components/ui.jsx";
import { screenshotPhoto } from "../lib/image.js";

const FAQ = [
  [
    "The printer won't connect or print",
    <>
      Turn the printer on and charge it. In <Link to="/settings/printer">Settings › Printer</Link> pick the paper size, then tap <b>Test print</b>. On Android use Chrome; if the
      printer switches off when printing, turn on <b>Slow mode</b> and keep the logo off. Still stuck? Use <b>Diagnostics</b> in Settings and send us a screenshot.
    </>,
  ],
  [
    "Printing from iPhone",
    <>
      Apple doesn't allow Safari or Chrome to use Bluetooth printers. Install the free <b>Bluefy</b> browser from the App Store, open this app in it, log in and tap
      Connect. Until then, use <b>PDF</b> to share bills on WhatsApp.
    </>,
  ],
  [
    "My plan or payment isn't showing",
    <>
      Razorpay payments start your plan straight away. If you paid by UPI or a payment link, it's checked by us, usually within a few hours. Open{" "}
      <Link to="/plans">Plans</Link> to see the status. Send us the payment reference below if it's taking long.
    </>,
  ],
  [
    "Bills say “waiting to upload”",
    <>
      Bills are saved on your phone first, so billing works without internet. They upload by themselves when you're back online. Tap the yellow “bills to sync” button
      at the top to try again now.
    </>,
  ],
  [
    "Udhar (credit) and reminders",
    <>
      Choose <b>Udhar</b> as the payment on a bill and pick the customer. In <Link to="/customers">Udhar</Link> you can add payments, send WhatsApp reminders to everyone
      at once, and the account closes by itself when it's fully paid.
    </>,
  ],
  [
    "I forgot my password or email",
    <>
      Log out, then use <b>Forgot password?</b> (a code comes to your email) or <b>Forgot email?</b> (find it with your phone number) on the login screen.
    </>,
  ],
  [
    "Adding photos to the menu",
    <>
      In <Link to="/menu">Menu</Link>, edit an item and tap <b>Find photo</b> for a free photo (uses no storage), or take a photo with the camera. Photos are made small
      automatically.
    </>,
  ],
];

export default function Help() {
  const toast = useToast();
  const [threads, setThreads] = useState(null);
  const [open, setOpen] = useState(null); // thread id
  const [composing, setComposing] = useState(false);
  const [whatsapp, setWhatsapp] = useState(null);
  const { busy, error, run } = useAction();

  const load = () => run(async () => setThreads((await get("/help/threads")).threads));
  useEffect(() => {
    load();
    get("/help/config").then((c) => setWhatsapp(c.whatsapp)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const thread = threads?.find((t) => t.id === open);
  useEffect(() => {
    if (thread?.unreadByShop) post(`/help/threads/${thread.id}/read`).then(load).catch(() => {});
  }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <h1>Help</h1>
        <div className="btn-row">
          {whatsapp && (
            <a className="btn" href={`https://wa.me/${whatsapp}?text=${encodeURIComponent("Hello, I need help with the billing app.")}`} target="_blank" rel="noopener noreferrer">
              💬 WhatsApp us
            </a>
          )}
          <button className="btn btn-primary" onClick={() => (setComposing(true), setOpen(null))}>✉️ Send a message</button>
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="help-grid">
        <section className="card stack">
          <h2>Common questions</h2>
          {FAQ.map(([q, a]) => (
            <details key={q} className="faq">
              <summary>{q}</summary>
              <div className="small">{a}</div>
            </details>
          ))}
        </section>

        <section className="card stack">
          {composing ? (
            <NewMessage
              onCancel={() => setComposing(false)}
              onSent={(t) => {
                toast("Message sent. We'll reply here and by email.");
                setComposing(false);
                setThreads((list) => [t, ...(list || [])]);
                setOpen(t.id);
              }}
            />
          ) : thread ? (
            <Thread thread={thread} onBack={() => setOpen(null)} onChange={(t) => setThreads((l) => l.map((x) => (x.id === t.id ? t : x)))} />
          ) : (
            <>
              <h2>My messages</h2>
              {threads === null && <div className="empty">{busy ? "Loading…" : ""}</div>}
              {threads?.length === 0 && <div className="empty">No messages yet. Tap “Send a message” if something isn't working.</div>}
              {threads?.map((t) => (
                <button key={t.id} className={"help-row" + (t.unreadByShop ? " unread" : "")} onClick={() => setOpen(t.id)}>
                  <div className="shop-title">
                    <b>{t.subject}</b>
                    <span className={"tag " + (t.status === "answered" ? "good" : t.status === "closed" ? "" : "warn")}>
                      {t.status === "answered" ? "replied" : t.status === "closed" ? "closed" : "waiting"}
                    </span>
                    {t.unreadByShop && <span className="tag accent">new reply</span>}
                  </div>
                  <div className="small muted">{t.last}</div>
                  <div className="small muted">{fmtDateTime(t.updatedAt)}</div>
                </button>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ScreenshotPicker({ image, setImage }) {
  const toast = useToast();
  return (
    <div className="btn-row">
      <label className="btn btn-sm">
        📎 {image ? "Change screenshot" : "Add screenshot"}
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files[0];
            e.target.value = "";
            if (!f) return;
            try {
              setImage(await screenshotPhoto(f));
            } catch (err) {
              toast(err.message);
            }
          }}
        />
      </label>
      {image && (
        <>
          <img src={image} alt="" className="help-thumb" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setImage("")}>Remove</button>
        </>
      )}
    </div>
  );
}

function NewMessage({ onCancel, onSent }) {
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [image, setImage] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), run(async () => onSent(await post("/help/threads", { subject, text, ...(image && { image }) }))))}>
      <h2>Send a message</h2>
      <Field label="What's it about?">
        <input required minLength={3} maxLength={100} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Printer not printing" />
      </Field>
      <Field label="Tell us what happened" hint="Which phone, what you tapped, and any error message.">
        <textarea required minLength={2} maxLength={2000} rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <ScreenshotPicker image={image} setImage={setImage} />
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
      </div>
    </form>
  );
}

export function Conversation({ messages, mine, names = { shop: "You", admin: "Support" } }) {
  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={"bubble " + (m.from === mine ? "me" : "them")}>
          <div className="bubble-text">{m.text}</div>
          {m.image && (
            <a href={m.image} target="_blank" rel="noopener noreferrer">
              <img src={m.image} alt="Screenshot" className="help-thumb lg" />
            </a>
          )}
          <div className="bubble-meta">{names[m.from]} · {fmtDateTime(m.at)}</div>
        </div>
      ))}
    </div>
  );
}

function Thread({ thread, onBack, onChange }) {
  const [text, setText] = useState("");
  const [image, setImage] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="stack">
      <div className="shop-title">
        <button className="btn btn-sm btn-ghost" onClick={onBack}>← Back</button>
        <b>{thread.subject}</b>
      </div>
      <Conversation messages={thread.messages} mine="shop" />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            onChange(await post(`/help/threads/${thread.id}/messages`, { text, ...(image && { image }) }));
            setText("");
            setImage("");
          });
        }}
      >
        <textarea rows={3} required minLength={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" className="input" />
        <ScreenshotPicker image={image} setImage={setImage} />
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </div>
  );
}
