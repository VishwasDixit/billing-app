# Billing App (58 mm receipt)

A simple billing / point-of-sale web app. No install, no server: everything runs in the browser and is saved in the browser's local storage.

## Run
Double-click `index.html` (Chrome recommended), or open it from the browser with **File → Open File…**.

## Use
- **Add items:** click **+ Add Item** and enter a name, a price and an optional category.
- **Edit or delete items:** tick **Edit menu**, then click an item.
- **Bill:** tap items to add them to the cart. Use **− / +** or type a quantity. Set a discount as % or a flat amount.
- **Settings:** shop name, address, phone, GSTIN, currency symbol, GST %, footer text and the next bill number.
  GST is applied after the discount and printed as CGST and SGST halves.
- **Print Bill:** prints the receipt. Afterwards, confirm to clear the cart and move to the next bill number.

Menu, settings and bill number are stored per browser. Clearing the browser's site data erases them.

## Live app
https://vishwasdixit.github.io/billing-app/

## Printing to a 58 mm Bluetooth printer (e.g. Seznik)
Cheap Bluetooth thermal printers have no computer/phone driver, so the normal print dialog can't see them.
The app instead sends ESC/POS commands straight to the printer over Bluetooth, the same way apps like
Bill Sarthy do. Choose how in **Settings → Printer → Print method**.

The printer accepts only **one connection at a time**: close Bill Sarthy (or disconnect it) before printing from here.

### Android (Chrome) — "Bluetooth printer"
1. Turn on Bluetooth **and Location** (Android needs Location for Bluetooth scanning).
2. Open the live app link in **Chrome**.
3. Tap **Connect** above *Print Bill* and pick your printer from the list.
4. Settings → **Test print** to check. Then print bills normally.

If your printer does **not appear** in the list, it only supports classic Bluetooth. Use RawBT instead:
1. Install **RawBT** from the Play Store, open it, and select your paired printer there.
2. In the app, Settings → Print method → **RawBT app (Android)**.
3. Print Bill now hands the receipt to RawBT, which prints it.

### Mac (Chrome)
1. System Settings → Privacy & Security → **Bluetooth**: allow Google Chrome.
2. Open the live app link in Chrome, click **Connect**, pick the printer.
3. If it is not listed: pair the printer in System Settings → Bluetooth (PIN is usually `0000` or `1234`),
   then Settings → Print method → **Bluetooth serial**, and click **Connect** again.

### Tuning
- **Characters per line:** 32 for most 58 mm printers. Run *Test print*: if the number ruler wraps, lower it (e.g. 30).
- **Cut paper:** only if your printer has an auto-cutter.
- **Large shop name & total:** prints the shop name and total in big, bold text (uses more battery).
- The `₹` sign is printed as `Rs.` because these printers can't print it.

### Troubleshooting: printer switches off or disconnects when printing
1. **Charge the printer fully.** Printing draws a burst of power, and a weak battery shuts cheap printers off.
   Print once from Bill Sarthy: if it switches off there too, it's the battery or the printer, not this app.
2. Keep **Large shop name & total** off (the default). Bold, double-size text uses the most power.
3. Open **Settings → Diagnose printer → Connect printer**. Press **Send Hello** on each writable channel.
   When one prints "Hello", press **Use this** on it. The app remembers that channel for this printer.
4. Still dropping? Turn on **Slow mode** in Settings.
5. If nothing works from Chrome, use the **RawBT** method on Android.

### Printer installed in the OS
If you have a printer with a real driver, choose **Browser print dialog** (paper 58 mm, margins None, no headers/footers).
