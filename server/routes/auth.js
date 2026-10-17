import { z } from "zod";
import { HttpError, respond } from "../http.js";
import { hashPassword, checkPassword, sessionCookie, clearCookie, publicUser, isAdminEmail, assertAuthConfigured } from "../auth.js";
import { TRIAL_DAYS } from "../subscription.js";
import { defaultMenu, GRILLHIVE_SHOP } from "../seed/grillhive-menu.js";
import { publicShop } from "./shop.js";

const Register = z.object({
  shopName: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(40),
  phone: z.string().trim().regex(/^[0-9+\- ]{10,15}$/, "enter a valid phone number"),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(6, "must be at least 6 characters").max(100),
});

const Login = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export function newShop({ name, phone, ownerEmail }) {
  const now = new Date();
  const isAdmin = isAdminEmail(ownerEmail);
  return {
    name,
    logo: "",
    address: isAdmin ? GRILLHIVE_SHOP.address : "",
    phone: phone || "",
    gstin: "",
    footer: isAdmin ? GRILLHIVE_SHOP.footer : "Thank you! Visit again.",
    currency: "₹",
    gstPercent: 0,
    defaultDiscount: { type: "percent", value: 0 },
    printer: { paperSize: 58, method: "bluetooth", charsPerLine: 32, largeText: false, slowMode: false, cut: false, printLogo: false },
    deviceSeq: 0,
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
    subscription: null,
    createdAt: now,
  };
}

async function sessionPayload(db, user) {
  const shop = await db.collection("shops").findOne({ _id: user.shopId });
  return { user: publicUser(user), shop: publicShop(shop, isAdminEmail(user.email)) };
}

export default [
  [
    "POST",
    "/auth/register",
    async ({ db, body }) => {
      const input = Register.parse(body);
      assertAuthConfigured();
      if (await db.collection("users").findOne({ email: input.email })) {
        throw new HttpError(409, "An account with this email already exists. Please log in.");
      }
      const shop = newShop({ name: input.shopName, phone: input.phone, ownerEmail: input.email });
      const { insertedId: shopId } = await db.collection("shops").insertOne(shop);
      await db.collection("menuItems").insertMany(defaultMenu(shopId));
      const user = {
        shopId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash: await hashPassword(input.password),
        createdAt: new Date(),
      };
      try {
        user._id = (await db.collection("users").insertOne(user)).insertedId;
      } catch (err) {
        // Lost a race with another sign-up using the same email.
        await db.collection("shops").deleteOne({ _id: shopId });
        await db.collection("menuItems").deleteMany({ shopId });
        if (err.code === 11000) throw new HttpError(409, "An account with this email already exists. Please log in.");
        throw err;
      }
      return respond(201, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  [
    "POST",
    "/auth/login",
    async ({ db, body }) => {
      const input = Login.parse(body);
      const user = await db.collection("users").findOne({ email: input.email });
      if (!user || !(await checkPassword(input.password, user.passwordHash))) {
        throw new HttpError(401, "Wrong email or password.");
      }
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  ["POST", "/auth/logout", async () => respond(200, { ok: true }, { "Set-Cookie": clearCookie() }), { auth: false }],
  ["GET", "/auth/me", async ({ db, user }) => sessionPayload(db, user)],
  [
    "POST",
    "/auth/password",
    async ({ db, user, body }) => {
      const { current, password } = z
        .object({ current: z.string().min(1), password: z.string().min(6, "must be at least 6 characters").max(100) })
        .parse(body);
      if (!(await checkPassword(current, user.passwordHash))) throw new HttpError(400, "Current password is wrong.");
      await db.collection("users").updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
      return { ok: true };
    },
  ],
];
