// Udhar WhatsApp messages in the shopkeeper's / customer's language.
// Shared so the server can validate the language codes.

const rs = (n) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");

// Each language: reminder(name, due, shop) lines, and receipt(name, amount, shop, balance) lines.
const LANGS = {
  hinglish: {
    label: "Hinglish (Hindi in English letters)",
    reminder: (n, d, s) => [`Namaste ${n} ji 🙏`, `${s} par aapka udhar ${d} baaki hai.`, `Kripya jaldi bhugtan karein.`],
    thanks: "Dhanyavaad!",
    receipt: (n, a, s) => [`Namaste ${n} ji 🙏`, `${s} ko aapka ${a} mil gaya hai. Dhanyavaad!`],
    balance: (b) => `Baaki udhar: ${b}`,
    cleared: "Aapka pura udhar chuk gaya hai ✅",
  },
  hindi: {
    label: "हिन्दी (Hindi)",
    reminder: (n, d, s) => [`नमस्ते ${n} जी 🙏`, `${s} पर आपका ${d} उधार बाकी है।`, `कृपया जल्द से जल्द भुगतान करें।`],
    thanks: "धन्यवाद!",
    receipt: (n, a, s) => [`नमस्ते ${n} जी 🙏`, `${s} को आपका ${a} मिल गया है। धन्यवाद!`],
    balance: (b) => `बाकी उधार: ${b}`,
    cleared: "आपका पूरा उधार चुक गया है ✅",
  },
  english: {
    label: "English",
    reminder: (n, d, s) => [`Hello ${n} 🙏`, `This is a reminder that ${d} is pending at ${s}.`, `Please pay at your earliest convenience.`],
    thanks: "Thank you!",
    receipt: (n, a, s) => [`Hello ${n} 🙏`, `${s} has received your payment of ${a}. Thank you!`],
    balance: (b) => `Balance due: ${b}`,
    cleared: "Your account is fully cleared ✅",
  },
  marathi: {
    label: "मराठी (Marathi)",
    reminder: (n, d, s) => [`नमस्कार ${n} 🙏`, `${s} येथे तुमची ${d} उधारी बाकी आहे.`, `कृपया लवकरात लवकर पैसे भरा.`],
    thanks: "धन्यवाद!",
    receipt: (n, a, s) => [`नमस्कार ${n} 🙏`, `${s} ला तुमचे ${a} मिळाले. धन्यवाद!`],
    balance: (b) => `बाकी उधारी: ${b}`,
    cleared: "तुमची संपूर्ण उधारी फिटली आहे ✅",
  },
  gujarati: {
    label: "ગુજરાતી (Gujarati)",
    reminder: (n, d, s) => [`નમસ્તે ${n} 🙏`, `${s} પર તમારું ${d} ઉધાર બાકી છે.`, `કૃપા કરીને જલ્દી ચુકવણી કરો.`],
    thanks: "આભાર!",
    receipt: (n, a, s) => [`નમસ્તે ${n} 🙏`, `${s} ને તમારા ${a} મળી ગયા છે. આભાર!`],
    balance: (b) => `બાકી ઉધાર: ${b}`,
    cleared: "તમારું પૂરું ઉધાર ચૂકવાઈ ગયું છે ✅",
  },
  punjabi: {
    label: "ਪੰਜਾਬੀ (Punjabi)",
    reminder: (n, d, s) => [`ਸਤ ਸ੍ਰੀ ਅਕਾਲ ${n} ਜੀ 🙏`, `${s} ਤੇ ਤੁਹਾਡਾ ${d} ਉਧਾਰ ਬਾਕੀ ਹੈ।`, `ਕਿਰਪਾ ਕਰਕੇ ਜਲਦੀ ਭੁਗਤਾਨ ਕਰੋ।`],
    thanks: "ਧੰਨਵਾਦ!",
    receipt: (n, a, s) => [`ਸਤ ਸ੍ਰੀ ਅਕਾਲ ${n} ਜੀ 🙏`, `${s} ਨੂੰ ਤੁਹਾਡੇ ${a} ਮਿਲ ਗਏ ਹਨ। ਧੰਨਵਾਦ!`],
    balance: (b) => `ਬਾਕੀ ਉਧਾਰ: ${b}`,
    cleared: "ਤੁਹਾਡਾ ਸਾਰਾ ਉਧਾਰ ਚੁਕਤਾ ਹੋ ਗਿਆ ਹੈ ✅",
  },
  bengali: {
    label: "বাংলা (Bengali)",
    reminder: (n, d, s) => [`নমস্কার ${n} 🙏`, `${s}-এ আপনার ${d} বাকি আছে।`, `অনুগ্রহ করে তাড়াতাড়ি পরিশোধ করুন।`],
    thanks: "ধন্যবাদ!",
    receipt: (n, a, s) => [`নমস্কার ${n} 🙏`, `${s} আপনার ${a} পেয়েছে। ধন্যবাদ!`],
    balance: (b) => `বাকি: ${b}`,
    cleared: "আপনার সম্পূর্ণ বাকি পরিশোধ হয়ে গেছে ✅",
  },
  tamil: {
    label: "தமிழ் (Tamil)",
    reminder: (n, d, s) => [`வணக்கம் ${n} 🙏`, `${s}-இல் உங்கள் ${d} கடன் நிலுவையில் உள்ளது.`, `தயவுசெய்து விரைவில் செலுத்துங்கள்.`],
    thanks: "நன்றி!",
    receipt: (n, a, s) => [`வணக்கம் ${n} 🙏`, `${s}-க்கு உங்கள் ${a} கிடைத்தது. நன்றி!`],
    balance: (b) => `மீதமுள்ள கடன்: ${b}`,
    cleared: "உங்கள் முழு கடனும் செலுத்தப்பட்டது ✅",
  },
  telugu: {
    label: "తెలుగు (Telugu)",
    reminder: (n, d, s) => [`నమస్కారం ${n} గారు 🙏`, `${s} వద్ద మీ ${d} బాకీ ఉంది.`, `దయచేసి త్వరగా చెల్లించండి.`],
    thanks: "ధన్యవాదాలు!",
    receipt: (n, a, s) => [`నమస్కారం ${n} గారు 🙏`, `${s}కి మీ ${a} అందింది. ధన్యవాదాలు!`],
    balance: (b) => `మిగిలిన బాకీ: ${b}`,
    cleared: "మీ బాకీ మొత్తం తీరిపోయింది ✅",
  },
};

export const LANGUAGE_CODES = [...Object.keys(LANGS), "custom"];
export const LANGUAGE_OPTIONS = [...Object.entries(LANGS).map(([code, l]) => [code, l.label]), ["custom", "Custom message (write your own)"]];
export const DEFAULT_LANGUAGE = "hinglish";
export const DEFAULT_TEMPLATE = "Namaste {name} ji, {shop} par aapka {amount} baaki hai. Kripya jaldi bhugtan karein. UPI: {upi}";

// Customer's own language, else the shop's, else Hinglish.
export const languageFor = (customer, shop) => customer?.language || shop?.reminderLanguage || DEFAULT_LANGUAGE;

export function reminderText(customer, shop) {
  const lang = languageFor(customer, shop);
  if (lang === "custom") {
    return (shop.reminderTemplate || DEFAULT_TEMPLATE)
      .replaceAll("{name}", customer.name)
      .replaceAll("{amount}", rs(customer.due))
      .replaceAll("{shop}", shop.name)
      .replaceAll("{upi}", shop.upiId || "")
      .replace(/\s*UPI:\s*$/i, "") // drop a dangling "UPI:" when no UPI ID is set
      .trim();
  }
  const L = LANGS[lang] || LANGS[DEFAULT_LANGUAGE];
  return [...L.reminder(customer.name, rs(customer.due), shop.name), shop.upiId ? `UPI: ${shop.upiId}` : "", L.thanks].filter(Boolean).join("\n");
}

export function receiptText(customer, shop, amount, balance) {
  const lang = languageFor(customer, shop);
  // Custom templates are for reminders; receipts then use English.
  const L = LANGS[lang] || LANGS.english;
  return [...L.receipt(customer.name, rs(amount), shop.name), balance > 0 ? L.balance(rs(balance)) : L.cleared].join("\n");
}
