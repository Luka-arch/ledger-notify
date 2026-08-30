// Ledger's daily notification check, running on GitHub Actions instead of a
// Firebase Cloud Function — this needs no Blaze plan at all. Sending a push
// through Firebase Cloud Messaging is free on any Firebase plan; the only
// thing Blaze gates is Cloud Functions itself (i.e. "run code on a
// schedule"), so this script just does that part somewhere else and talks
// to the same free Firestore + FCM as before via a service account.
const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT env var (should be set from the GitHub secret).");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();
const messaging = admin.messaging();

function pad(n) { return String(n).padStart(2, "0"); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

// Kept in sync by hand with App.jsx's copy — small enough that sharing a
// module between the app and this script isn't worth the build complexity.
const MOTIVATIONAL_MESSAGES = [
  "One day at a time — your budget is on track. 🌱",
  "Every ₾ you save today is a favor to future you. 💪",
  "No bills sneaking up on you this week — nice work staying ahead. ✨",
  "Small consistent habits beat big one-off efforts. Keep going!",
  "You're building real financial breathing room. Proud of you. 🎉",
  "Progress, not perfection — check your goals for a quick win.",
  "A calm bank balance is a calm mind. You've got this.",
  "Take two minutes today to glance at Insights — awareness compounds.",
];
function pickMotivational() {
  return MOTIVATIONAL_MESSAGES[Math.floor(Math.random() * MOTIVATIONAL_MESSAGES.length)];
}

// Sends one push per message so each bill gets its own notification, then
// reports back any token FCM says is dead so the caller can prune it.
async function sendAll(tokens, messages) {
  const deadTokens = new Set();
  for (const msg of messages) {
    const resp = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      webpush: { notification: { icon: "/favicon.svg" }, fcmOptions: { link: "/" } },
    });
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          deadTokens.add(tokens[i]);
        }
      }
    });
  }
  return deadTokens;
}

async function processLedgerDoc(docSnap) {
  const data = docSnap.data() || {};
  const notif = { enabled: false, daysBefore: 3, motivational: true, ...(data.settings?.notifications || {}) };
  const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
  if (!notif.enabled || tokens.length === 0) return;

  const today = todayISO();
  const windowDays = Number(notif.daysBefore) || 3;
  const currency = data.settings?.currency || "";
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const messages = [];
  let tasksChanged = false;

  const updatedTasks = tasks.map((t) => {
    if (t.paid || !t.dueDate) return t;
    const diff = daysBetween(today, t.dueDate);
    if (diff > windowDays) return t;
    if (t.notifiedDate === today) return t;
    let body;
    if (diff < 0) body = `${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} overdue — ${currency}${Number(t.amount).toFixed(2)}`;
    else if (diff === 0) body = `Due today — ${currency}${Number(t.amount).toFixed(2)}`;
    else body = `Due in ${diff} day${diff === 1 ? "" : "s"} — ${currency}${Number(t.amount).toFixed(2)}`;
    messages.push({ title: `${diff < 0 ? "Overdue: " : "Upcoming: "}${t.name}`, body });
    tasksChanged = true;
    return { ...t, notifiedDate: today };
  });

  let settingsChanged = false;
  let updatedSettings = data.settings;
  if (notif.motivational && notif.lastMotivationalDate !== today) {
    messages.push({ title: "Ledger", body: pickMotivational() });
    updatedSettings = { ...data.settings, notifications: { ...notif, lastMotivationalDate: today } };
    settingsChanged = true;
  }

  if (messages.length === 0) return;

  const deadTokens = await sendAll(tokens, messages);

  const updateFields = {};
  if (tasksChanged) updateFields.tasks = updatedTasks;
  if (settingsChanged) updateFields.settings = updatedSettings;
  if (deadTokens.size > 0) updateFields.fcmTokens = tokens.filter((t) => !deadTokens.has(t));
  if (Object.keys(updateFields).length > 0) await docSnap.ref.update(updateFields);

  console.log(`${docSnap.id}: sent ${messages.length} notification(s)`);
}

async function main() {
  const snap = await db.collection("ledgers").get();
  console.log(`Checking ${snap.size} ledger doc(s)…`);
  await Promise.all(
    snap.docs.map((d) => processLedgerDoc(d).catch((err) => console.error(`Error processing ${d.id}:`, err)))
  );
  await processRequests().catch((err) => console.error("Error processing requests:", err));
  console.log("Done.");
}

// ---- bill-split requests ----
// Push to just one person's registered devices — used for both the "new
// request" and "resolved" notices below.
async function pushToUid(uid, title, body) {
  const snap = await db.collection("ledgers").doc(uid).get();
  const tokens = Array.isArray(snap.data()?.fcmTokens) ? snap.data().fcmTokens : [];
  if (tokens.length === 0) return;
  const resp = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { notification: { icon: "/favicon.svg" }, fcmOptions: { link: "/" } },
  });
  const deadTokens = new Set();
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) deadTokens.add(tokens[i]);
    }
  });
  if (deadTokens.size > 0) {
    await snap.ref.update({ fcmTokens: tokens.filter((t) => !deadTokens.has(t)) });
  }
}

// Notifies about brand-new pending requests (to the recipient) and requests
// that just got accepted or declined (to the original requester). Each
// request doc gets a "notified*" flag once handled so it's a one-time push,
// no matter how often this script runs.
async function processRequests() {
  const pendingSnap = await db.collection("requests").where("status", "==", "pending").get();
  for (const reqDoc of pendingSnap.docs) {
    const r = reqDoc.data();
    if (r.notifiedPending) continue;
    const what = r.description || r.category || "a shared bill";
    await pushToUid(r.toUid, "New bill request", `${r.fromEmail} wants ${r.amount} for ${what}`).catch((err) => console.error(`pushToUid failed for ${reqDoc.id}:`, err));
    await reqDoc.ref.update({ notifiedPending: true });
  }
  if (pendingSnap.size > 0) console.log(`Requests: notified about ${pendingSnap.docs.filter((d) => !d.data().notifiedPending).length} new pending request(s)`);

  const resolvedSnap = await db.collection("requests").where("status", "in", ["accepted", "declined"]).get();
  for (const reqDoc of resolvedSnap.docs) {
    const r = reqDoc.data();
    if (r.notifiedResolved) continue;
    if (r.status === "accepted") {
      await pushToUid(r.fromUid, "Request accepted", `${r.toEmail} paid you ${r.amount} for ${r.description || r.category}`).catch((err) => console.error(`pushToUid failed for ${reqDoc.id}:`, err));
    } else {
      await pushToUid(r.fromUid, "Request declined", `${r.toEmail} declined your request for ${r.amount}`).catch((err) => console.error(`pushToUid failed for ${reqDoc.id}:`, err));
    }
    await reqDoc.ref.update({ notifiedResolved: true });
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
