// Built-in kitchen knowledge: a starter list of common dhaba ingredients, and standard
// recipes (quantities per FULL plate, steps) matched to dishes by name. A shop can add the
// starter items with one tap and start a dish from its standard recipe, then edit it.

// [name, category, unit kept in, typical price per unit (₹), shelf life (days), min stock]
export const STARTER = [
  ["Refined oil", "Oil & ghee", "L", 150, 180, 3],
  ["Mustard oil", "Oil & ghee", "L", 180, 180, 1],
  ["Desi ghee", "Oil & ghee", "kg", 600, 120, 0.5],
  ["Butter", "Dairy", "kg", 500, 30, 0.5],
  ["Paneer", "Dairy", "kg", 380, 3, 1],
  ["Milk", "Dairy", "L", 60, 2, 5],
  ["Curd", "Dairy", "kg", 80, 3, 2],
  ["Fresh cream", "Dairy", "L", 220, 5, 0.5],
  ["Cheese", "Dairy", "kg", 450, 30, 0.5],
  ["Onion", "Vegetables", "kg", 35, 20, 5],
  ["Tomato", "Vegetables", "kg", 30, 6, 4],
  ["Potato", "Vegetables", "kg", 25, 30, 5],
  ["Green chilli", "Vegetables", "kg", 60, 7, 0.5],
  ["Ginger", "Vegetables", "kg", 120, 15, 0.3],
  ["Garlic", "Vegetables", "kg", 160, 30, 0.3],
  ["Coriander leaves", "Vegetables", "kg", 80, 3, 0.2],
  ["Capsicum", "Vegetables", "kg", 60, 7, 1],
  ["Mixed vegetables", "Vegetables", "kg", 50, 4, 2],
  ["Cabbage", "Vegetables", "kg", 25, 7, 1],
  ["Carrot", "Vegetables", "kg", 40, 10, 1],
  ["Green peas", "Vegetables", "kg", 80, 5, 1],
  ["Spinach (palak)", "Vegetables", "kg", 40, 3, 1],
  ["Mushroom", "Vegetables", "kg", 200, 3, 0.5],
  ["Sweet corn", "Vegetables", "kg", 120, 30, 1],
  ["Lemon", "Vegetables", "pcs", 5, 10, 20],
  ["Atta (wheat flour)", "Grains & dal", "kg", 35, 60, 10],
  ["Maida", "Grains & dal", "kg", 40, 60, 5],
  ["Besan", "Grains & dal", "kg", 90, 90, 2],
  ["Rice", "Grains & dal", "kg", 60, 180, 5],
  ["Toor dal", "Grains & dal", "kg", 140, 180, 2],
  ["Urad dal (whole)", "Grains & dal", "kg", 130, 180, 1],
  ["Rajma", "Grains & dal", "kg", 150, 180, 1],
  ["Kabuli chana", "Grains & dal", "kg", 120, 180, 2],
  ["Poha", "Grains & dal", "kg", 60, 90, 1],
  ["Suji (rava)", "Grains & dal", "kg", 50, 90, 1],
  ["Noodles", "Grains & dal", "packet", 30, 180, 10],
  ["Bread", "Bakery", "packet", 45, 4, 3],
  ["Pav / Bun", "Bakery", "pcs", 5, 3, 20],
  ["Salt", "Masala", "kg", 25, 720, 1],
  ["Sugar", "Masala", "kg", 45, 720, 3],
  ["Haldi (turmeric)", "Masala", "g", 0.3, 365, 200],
  ["Red chilli powder", "Masala", "g", 0.4, 365, 200],
  ["Dhaniya powder", "Masala", "g", 0.3, 365, 200],
  ["Garam masala", "Masala", "g", 0.8, 365, 100],
  ["Jeera", "Masala", "g", 0.5, 365, 200],
  ["Kasuri methi", "Masala", "g", 1, 365, 50],
  ["Chhole masala", "Masala", "g", 0.8, 365, 100],
  ["Tea leaves", "Beverages", "kg", 500, 365, 0.5],
  ["Coffee powder", "Beverages", "g", 1.5, 365, 100],
  ["Soy sauce", "Sauces", "ml", 0.2, 365, 500],
  ["Chilli sauce", "Sauces", "ml", 0.2, 365, 500],
  ["Tomato ketchup", "Sauces", "ml", 0.15, 180, 1000],
  ["Cornflour", "Grains & dal", "g", 0.1, 365, 500],
  ["Jam", "Sauces", "g", 0.3, 180, 200],
  ["Parcel boxes", "Packaging", "pcs", 6, 720, 50],
];

// Standard recipes: per FULL plate (Half = 0.6×). [ingredient, qty, unit]
const R = (match, ingredients, steps, opts = {}) => ({ match, ingredients, steps, ...opts });
export const RECIPES = [
  R(/kulhad/, [["Milk", 120, "ml"], ["Tea leaves", 4, "g"], ["Sugar", 12, "g"], ["Ginger", 2, "g"]], ["Boil 60 ml water with crushed ginger.", "Add tea leaves and boil 1 min.", "Add milk and sugar, boil till it rises twice.", "Strain into a warm kulhad."], { single: true }),
  R(/\btea\b|chai/, [["Milk", 100, "ml"], ["Tea leaves", 4, "g"], ["Sugar", 10, "g"], ["Ginger", 2, "g"]], ["Boil 60 ml water with crushed ginger.", "Add tea leaves, boil 1 min.", "Add milk and sugar, boil till it rises twice.", "Strain and serve hot."], { single: true }),
  R(/coffee/, [["Milk", 150, "ml"], ["Coffee powder", 4, "g"], ["Sugar", 10, "g"]], ["Whisk coffee and sugar with 1 spoon hot water till frothy.", "Heat milk till steaming.", "Pour milk over the coffee and stir."], { single: true }),
  R(/lassi/, [["Curd", 200, "g"], ["Sugar", 25, "g"]], ["Whisk chilled curd with sugar (or salt + jeera for salted).", "Add a little cold water and ice.", "Serve in a tall glass."], { single: true }),
  R(/chaas/, [["Curd", 120, "g"], ["Jeera", 1, "g"], ["Salt", 2, "g"], ["Coriander leaves", 3, "g"]], ["Whisk curd with 150 ml cold water.", "Add roasted jeera powder, salt and coriander.", "Serve chilled."], { single: true }),
  R(/lemon|lime/, [["Lemon", 1, "pcs"], ["Sugar", 20, "g"], ["Salt", 1, "g"]], ["Squeeze lemon into a glass.", "Add sugar, a pinch of salt and chilled water/soda.", "Stir and serve with ice."], { single: true }),
  R(/chhol|chole|bhatur/, [["Kabuli chana", 70, "g"], ["Onion", 40, "g"], ["Tomato", 50, "g"], ["Chhole masala", 4, "g"], ["Refined oil", 30, "ml"], ["Maida", 90, "g"], ["Salt", 3, "g"]], ["Soak chana overnight and pressure cook till soft.", "Fry onion-tomato with chhole masala, add chana and simmer 15 min.", "For bhatura: knead maida with curd, rest 2 h, roll and deep fry.", "Serve hot with onion and pickle."]),
  R(/samosa/, [["Maida", 35, "g"], ["Potato", 70, "g"], ["Green peas", 10, "g"], ["Refined oil", 25, "ml"], ["Garam masala", 1, "g"], ["Salt", 2, "g"]], ["Boil and mash potatoes; mix peas, masala and salt.", "Knead maida with a little oil and water; rest 15 min.", "Roll, shape cones, fill and seal.", "Fry on medium heat till golden."], { single: true }),
  R(/pakod|pakor|bhaji|bonda/, [["Besan", 60, "g"], ["Onion", 60, "g"], ["Refined oil", 30, "ml"], ["Green chilli", 3, "g"], ["Salt", 2, "g"]], ["Mix besan, sliced onion, chilli, salt and a little water into a thick batter.", "Heat oil; drop small portions.", "Fry on medium till crisp and golden.", "Serve with green chutney."], { single: true }),
  R(/fries/, [["Potato", 200, "g"], ["Refined oil", 30, "ml"], ["Salt", 2, "g"]], ["Cut potatoes into fingers; soak in cold water 20 min; dry well.", "Fry at medium heat 5 min; rest.", "Fry again on high till crisp.", "Toss with salt (and masala / cheese for variants)."], { single: true }),
  R(/garlic bread/, [["Bread", 0.25, "packet"], ["Butter", 20, "g"], ["Garlic", 5, "g"]], ["Mix soft butter with chopped garlic and herbs.", "Spread on bread slices.", "Toast on tawa or oven till crisp."], { single: true }),
  R(/sandwich/, [["Bread", 0.2, "packet"], ["Butter", 10, "g"], ["Potato", 50, "g"], ["Onion", 15, "g"], ["Tomato", 20, "g"]], ["Butter the bread slices.", "Fill with the stuffing and sliced veggies.", "Grill till golden; cut and serve with ketchup."], { single: true }),
  R(/bun|bread butter|maska|jam/, [["Pav / Bun", 2, "pcs"], ["Butter", 15, "g"], ["Jam", 10, "g"]], ["Slit the bun/bread.", "Spread butter (and jam).", "Toast lightly on tawa."], { single: true }),
  R(/momo/, [["Maida", 60, "g"], ["Cabbage", 50, "g"], ["Carrot", 20, "g"], ["Onion", 15, "g"], ["Refined oil", 5, "ml"]], ["Knead soft maida dough; rest 20 min.", "Mix finely chopped cabbage, carrot, onion, salt.", "Roll thin, fill and pleat.", "Steam 10–12 min (tandoori: marinate and roast)."], { single: true }),
  R(/soup/, [["Mixed vegetables", 60, "g"], ["Cornflour", 10, "g"], ["Soy sauce", 5, "ml"], ["Refined oil", 5, "ml"], ["Salt", 2, "g"]], ["Sauté chopped veggies 2 min.", "Add water, sauces and salt; boil 5 min.", "Thicken with cornflour slurry.", "Serve hot."], { single: true }),
  R(/tikki|cutlet|kebab|corn ball/, [["Potato", 80, "g"], ["Mixed vegetables", 30, "g"], ["Refined oil", 20, "ml"], ["Garam masala", 1, "g"]], ["Mash potato with veggies and masala.", "Shape and coat with breadcrumbs.", "Shallow fry till crisp on both sides."], { single: true }),
  R(/crispy corn/, [["Sweet corn", 120, "g"], ["Cornflour", 20, "g"], ["Refined oil", 25, "ml"], ["Capsicum", 15, "g"]], ["Coat boiled corn with cornflour.", "Deep fry till crisp.", "Toss with onion, capsicum, chilli and salt."], { single: true }),
  R(/tandoori roti/, [["Atta (wheat flour)", 50, "g"]], ["Knead soft dough; rest 15 min.", "Roll, stick in tandoor till spotted.", "Brush with butter if ordered."], { single: true }),
  R(/roti|chapati|phulka/, [["Atta (wheat flour)", 40, "g"], ["Desi ghee", 2, "g"]], ["Knead soft dough; rest 15 min.", "Roll thin and cook on tawa both sides.", "Puff on flame; apply ghee."], { single: true }),
  R(/paratha/, [["Atta (wheat flour)", 80, "g"], ["Potato", 60, "g"], ["Butter", 10, "g"], ["Refined oil", 10, "ml"]], ["Prepare the stuffing (aloo/onion/veg/paneer) with salt and masala.", "Fill dough ball, roll gently.", "Cook on tawa with oil till golden both sides.", "Serve with butter, curd and pickle."], { single: true }),
  R(/dal makhani/, [["Urad dal (whole)", 60, "g"], ["Rajma", 10, "g"], ["Butter", 20, "g"], ["Fresh cream", 20, "ml"], ["Tomato", 50, "g"], ["Ginger", 5, "g"], ["Garlic", 5, "g"], ["Salt", 3, "g"]], ["Soak dal and rajma overnight; pressure cook till very soft.", "Cook tomato puree, ginger-garlic in butter.", "Add dal, simmer 30+ min, mashing a little.", "Finish with butter, cream and kasuri methi."]),
  R(/dal/, [["Toor dal", 70, "g"], ["Onion", 25, "g"], ["Tomato", 30, "g"], ["Desi ghee", 10, "g"], ["Jeera", 2, "g"], ["Haldi (turmeric)", 1, "g"], ["Salt", 3, "g"]], ["Pressure cook dal with haldi and salt (3 whistles).", "Make tadka: ghee, jeera, garlic, onion, tomato, chilli.", "Pour over dal; simmer 3 min.", "Garnish with coriander."]),
  R(/manchurian|chilli/, [["Cabbage", 80, "g"], ["Carrot", 20, "g"], ["Maida", 20, "g"], ["Cornflour", 20, "g"], ["Capsicum", 25, "g"], ["Soy sauce", 10, "ml"], ["Chilli sauce", 10, "ml"], ["Refined oil", 40, "ml"]], ["Make balls (or coat paneer/potato) with maida + cornflour; deep fry.", "Sauté garlic, onion, capsicum on high.", "Add sauces and a little cornflour slurry.", "Toss fried pieces in the sauce."]),
  R(/paneer/, [["Paneer", 120, "g"], ["Onion", 50, "g"], ["Tomato", 70, "g"], ["Butter", 15, "g"], ["Fresh cream", 15, "ml"], ["Garam masala", 2, "g"], ["Red chilli powder", 2, "g"], ["Salt", 3, "g"]], ["Make onion-tomato gravy with ginger-garlic and masalas.", "Blend smooth (for butter masala / shahi).", "Add paneer cubes; simmer 3–4 min.", "Finish with butter/cream and kasuri methi."]),
  R(/mushroom/, [["Mushroom", 150, "g"], ["Onion", 50, "g"], ["Tomato", 60, "g"], ["Refined oil", 20, "ml"], ["Garam masala", 2, "g"]], ["Sauté mushrooms till dry.", "Cook onion-tomato masala.", "Add mushrooms; simmer 5 min."]),
  R(/aloo|potato|mix veg|sev tamatar/, [["Potato", 150, "g"], ["Mixed vegetables", 60, "g"], ["Onion", 40, "g"], ["Tomato", 50, "g"], ["Refined oil", 20, "ml"], ["Jeera", 2, "g"], ["Haldi (turmeric)", 1, "g"], ["Salt", 3, "g"]], ["Heat oil, crackle jeera.", "Add onion, tomato and masalas; cook till oil leaves.", "Add vegetables/potatoes and cook covered till done.", "Garnish with coriander."]),
  R(/thali/, [["Toor dal", 50, "g"], ["Rice", 80, "g"], ["Atta (wheat flour)", 80, "g"], ["Potato", 80, "g"], ["Paneer", 50, "g"], ["Curd", 50, "g"], ["Refined oil", 20, "ml"], ["Salt", 4, "g"]], ["Plate: dal, sabzi, paneer dish, rice, 2–4 roti, curd, salad, pickle.", "Keep portions consistent using fixed katoris."], { single: true }),
  R(/noodle/, [["Noodles", 1, "packet"], ["Cabbage", 40, "g"], ["Capsicum", 20, "g"], ["Carrot", 20, "g"], ["Soy sauce", 10, "ml"], ["Refined oil", 20, "ml"]], ["Boil noodles al dente; toss with a little oil.", "Stir-fry veggies on high flame.", "Add noodles, sauces, salt; toss well."]),
  R(/fried rice|rice/, [["Rice", 120, "g"], ["Mixed vegetables", 50, "g"], ["Soy sauce", 8, "ml"], ["Refined oil", 20, "ml"]], ["Use cooled cooked rice.", "Stir-fry veggies on high flame.", "Add rice, soy sauce, salt; toss well."]),
  R(/poha/, [["Poha", 70, "g"], ["Onion", 30, "g"], ["Potato", 30, "g"], ["Refined oil", 10, "ml"], ["Haldi (turmeric)", 1, "g"]], ["Rinse poha; drain.", "Temper mustard, curry leaves, chilli; add onion and potato.", "Add poha, haldi, salt, sugar; steam 2 min.", "Finish with lemon and coriander."], { single: true }),
  R(/upma/, [["Suji (rava)", 70, "g"], ["Mixed vegetables", 40, "g"], ["Refined oil", 10, "ml"]], ["Dry roast suji.", "Temper mustard, curry leaves; add veggies.", "Add water and salt; boil; stir in suji till thick."], { single: true }),
];

const HALF = 0.6;

// The standard recipe for a dish name, scaled for the variant ("Half" ≈ 0.6 of Full).
export function standardRecipe(name, variants = [{ label: "" }]) {
  const n = String(name || "").toLowerCase();
  const r = RECIPES.find((x) => x.match.test(n));
  if (!r) return null;
  const forVariant = (label) => {
    const scale = /half/i.test(label || "") ? HALF : 1;
    return r.ingredients.map(([ingredient, qty, unit]) => ({ ingredient, qty: Math.round(qty * scale * 100) / 100, unit }));
  };
  return {
    variants: Object.fromEntries(variants.map((v) => [v.label || "", forVariant(v.label)])),
    steps: r.steps.map((text) => ({ text, minutes: null })),
  };
}
