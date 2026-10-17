// GrillHive "Pure Veg Dhaba" menu: the default menu for every new shop.
// Items with two prices use variants (Half/Full, Plain/Butter).

const one = (name, price, note) => ({ name, variants: [{ label: "", price }], ...(note ? { note } : {}) });
const hf = (name, half, full) => ({ name, variants: [{ label: "Half", price: half }, { label: "Full", price: full }] });
const pb = (name, plain, butter) => ({ name, variants: [{ label: "Plain", price: plain }, { label: "Butter", price: butter }] });

const MENU = {
  "Breakfast": [
    one("Samosa (1 Pc)", 12),
    one("Chhola Samosa", 25),
    one("Chhola Bhatura", 50),
    one("Garlic Bread", 40),
    one("Bun Makkhan", 25),
    one("Pyaj Pakode", 35),
    one("Poha", 35),
    one("Veg Upma", 35),
    one("Bread Butter", 30),
    one("Bread Butter Jam", 35),
    one("Bun Maska Jam", 30),
  ],
  "Snacks": [
    one("French Fries", 80),
    one("Masala Fries", 100),
    one("Cheese Fries", 130),
    one("Garlic Bread (4 Pcs)", 40),
    one("Cheese Garlic Bread", 70),
    one("Veg Sandwich", 50),
    one("Aloo Tikki Sandwich", 60),
    one("Corn Sandwich", 70),
    one("Paneer Sandwich", 90),
    one("Veg Momos (6 Pcs)", 90),
    one("Tandoori Momos (6 Pcs)", 140),
    one("Pyaj Pakode", 35),
    one("Mix Veg Pakode", 40),
  ],
  "Soup": [
    one("Veg Soup", 60),
    one("Sweet Corn Soup", 70),
    one("Hot & Sour Soup", 70),
    one("Manchow Soup", 80),
    one("Tomato Soup", 60),
  ],
  "Tea & Beverages": [
    one("Tea", 15),
    one("Kulhad Tea", 20),
    one("Coffee", 25),
    one("Masala Chaas", 15),
    one("Plain Chaas", 10),
    one("Sweet Lassi", 40),
    one("Salted Lassi", 40),
    one("Lemon Water", 15),
    one("Fresh Lime Soda", 25),
  ],
  "Chef Specials": [
    one("Paneer Pakoda", 90),
    one("Bread Pakoda", 25),
    one("Aloo Bonda", 20),
    one("Cheese Corn Balls (6 Pc)", 120),
    one("Veg Cutlet (2 Pc)", 60),
    one("Hara Bhara Kebab (6 Pc)", 120),
    one("Crispy Corn", 110),
  ],
  "Roti & Paratha": [
    pb("Tawa Roti", 10, 15),
    pb("Tandoori Roti", 15, 20),
    pb("Aalu Paratha", 40, 60),
    pb("Pyaj Paratha", 50, 70),
    pb("Mix Veg Paratha", 70, 90),
    pb("Paneer Paratha", 80, 100),
  ],
  "Dal Special": [
    hf("Dal Tadka", 80, 150),
    hf("Dal Fry", 90, 160),
    hf("Dal Makhani", 110, 200),
    hf("Mushroom Masala", 150, 270),
  ],
  "Main Course": [
    hf("Mix Veg", 100, 180),
    hf("Shahi Paneer", 140, 250),
    hf("Paneer Butter Masala", 150, 270),
    hf("Kadai Paneer", 150, 270),
    hf("Palak Paneer", 140, 250),
    hf("Matar Paneer", 120, 220),
    hf("Jeera Aloo", 90, 160),
    hf("Dum Aloo", 100, 180),
    hf("Sev Tamatar", 80, 150),
  ],
  "Thali": [
    one("Normal Thali", 70, "Dal, Rice, 4 Roti, Sabji, Salad, Achar"),
    one("Special Thali", 150, "Dal, Jeera/Green/Lemon Rice, 4 Roti with Butter, 2 Sabji, Salad, Raita"),
    one("Pet Bhar Thali", 150, "Dal, Rice, 8 Roti, Sabji, Achar, Salad"),
  ],
  "Chinese": [
    hf("Veg Noodles", 60, 90),
    hf("Fried Rice", 60, 90),
    hf("Manchurian", 90, 170),
    hf("Chilli Paneer", 120, 220),
    hf("Chilli Potato", 70, 130),
  ],
  "Bowl Meals": [
    one("Rice + Manchurian Bowl", 170),
    one("Veg Noodles + Manchurian Bowl", 170),
    one("Rice + Chilli Paneer Bowl", 220),
    one("Veg Noodles + Chilli Paneer Bowl", 220),
  ],
  "Sandwiches": [
    one("Veg Sandwich", 50),
    one("Aloo Tikki Sandwich", 60),
    one("Corn Sandwich", 70),
    one("Paneer Sandwich", 90),
  ],
};

export function defaultMenu(shopId) {
  let sort = 0;
  const now = new Date();
  return Object.entries(MENU).flatMap(([category, items]) =>
    items.map((it) => ({ shopId, category, ...it, active: true, sort: sort++, createdAt: now }))
  );
}

// Filled in for the admin's own shop on registration.
export const GRILLHIVE_SHOP = {
  address: "Pahadpur Road, BKT, Lucknow",
  phone: "9336463647",
  footer: "Thank you! Visit again. Insta: @grill.hive",
};
