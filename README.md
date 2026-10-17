# Billing – shop POS with thermal printing and sales analytics

A billing app any shopkeeper can sign up for:
- **Billing:** a menu with Half/Full and Plain/Butter prices, a cart, a discount, GST and Cash/UPI/Card payment.
- **Printing:** prints to 58 / 80 / 110 mm Bluetooth thermal printers, or shares the bill as a PDF.
- **Offline:** bills are saved on the device first and upload to MongoDB when the internet returns.
- **Dashboard:** sales, bills, average bill, expenses, profit, growth, busy hours, top items and categories, and a CSV export.
- **Plans:** a 7-day free trial, then **₹49/month** or **₹400/year**, paid through Razorpay or by UPI with the admin approving it.
- **Admin panel:** lists all shops, approves UPI payments, extends plans and resets passwords.
- **Default menu:** every new shop starts with the GrillHive dhaba menu (80 items, 12 categories), which it can edit.

## Tech
- **Frontend:** React + Vite, as an installable PWA. IndexedDB holds the offline bill queue.
- **API:** one Vercel serverless function (`api/index.js`) that routes to `server/routes/*`.
- **Database:** MongoDB (Atlas in production).
- **Shared code:** `shared/totals.js` holds the bill arithmetic, used by both the browser and the server.
- **Printer code:** `src/printer/`. One receipt layout feeds ESC/POS printing, the PDF and the browser print dialog.

## Run locally
```bash
npm install
```
```bash
npm run dev
```
Then open http://localhost:5173.

Without `MONGODB_URI` set, the local API starts a built-in MongoDB that keeps its data in `.data/`. To make your account the admin, copy `.env.example` to `.env.local` and set `ADMIN_EMAIL`.

To run the tests (they use a temporary in-memory MongoDB):
```bash
npm test
```

## Deploy (free: Vercel + MongoDB Atlas)
1. **MongoDB Atlas.** At https://cloud.mongodb.com:
   1. Create a free **M0** cluster.
   2. Under **Database Access**, add a user with a password.
   3. Under **Network Access**, allow `0.0.0.0/0`, since Vercel's IP addresses change.
   4. Click **Connect → Drivers** and copy the `mongodb+srv://…` connection string.
2. **Vercel.** At https://vercel.com:
   1. Click **Add New → Project** and import the `billing-app` GitHub repo.
   2. Under **Environment Variables**, add every key from `.env.example`:
      - `MONGODB_URI`
      - `JWT_SECRET` (any long random string)
      - `ADMIN_EMAIL`
      - `UPI_ID` and `UPI_NAME`
      - the Razorpay keys, once you have them
   3. Deploy. Every push to the production branch then redeploys.
3. **Razorpay** (optional, for automatic online payments):
   1. In the dashboard, go to **API Keys** and create test keys. These go in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
   2. Under **Webhooks**, add `https://<your-app>.vercel.app/api/pay/razorpay/webhook` with the events `payment.captured` and `order.paid`. Set a secret and put it in `RAZORPAY_WEBHOOK_SECRET`.
   3. Switch to live keys after Razorpay approves your KYC.

   Without Razorpay keys, the Plans page offers only UPI QR payment, which you approve in **Admin**.
4. Register using your `ADMIN_EMAIL`. Your shop gets the Admin tab and never expires.

## Printing to a Bluetooth thermal printer
Cheap Bluetooth thermal printers (e.g. Seznik) have no driver. The app sends ESC/POS commands to them directly. Set it up in **Settings → Printer**:
- **Paper size:** 58 / 80 / 110 mm. This sets the characters per line: 32 / 48 / 64.
- **Print method:**
  - **Bluetooth printer:** for Chrome on Android or a computer. Tap **Connect** above *Print bill*.
  - **RawBT app:** for Android printers that Chrome can't see.
  - **Bluetooth serial:** for a computer, with the printer paired first.
  - **Browser print dialog:** for printers installed in the OS.
- **Options:** print logo, large text, slow mode, cut paper.
- **Test print** and **Diagnose printer** (for picking the right Bluetooth channel).

If the printer switches off while printing, charge it and keep **Print logo** and **Large text** off. Close other printer apps (e.g. Bill Sarthy) first, because the printer accepts only one connection at a time. Bluetooth from a web page doesn't work on iPhone. Use Android or a computer.

The v1 single-page app is kept in `docs/` (still served by GitHub Pages at https://vishwasdixit.github.io/billing-app/ until the switch to Vercel is done).
