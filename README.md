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

## 58 mm printer setup (macOS)
1. Install the printer's driver and add it in **System Settings → Printers & Scanners**.
2. In Chrome's print dialog (opened by **Print Bill**), go to **More settings** and set:
   - **Paper size:** 58 mm, or the printer's roll size (e.g. "58 x 210 mm")
   - **Margins:** None
   - **Scale:** Default (100%)
   - **Headers and footers:** off
   Chrome remembers these choices for next time.
3. If your driver has no 58 mm size, create one: in Chrome's print dialog choose **Print using system dialog → Paper Size → Manage Custom Sizes**, then set width 58 mm, height 200 mm and margins 0.

**Tip:** to skip the print dialog entirely, launch Chrome with `--kiosk-printing`. It then prints straight to the default printer.

```bash
open -a "Google Chrome" --args --kiosk-printing
```
