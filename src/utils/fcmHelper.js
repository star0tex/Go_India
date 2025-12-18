import admin from "../utils/firebase.js";
import User from "../models/User.js";

/**
 * Convert all data payload values to STRING
 * (FCM REQUIREMENT)
 */
const toStringData = (obj = {}) => {
  const result = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined && obj[key] !== null) {
      result[key] = String(obj[key]);
    }
  });
  return result;
};

/**
 * SAFE FCM SEND (NO invalid-argument errors)
 */
export const sendFCMNotification = async ({
  userId,
  token,
  title,
  body,
  type = "general",
  data = {},
}) => {
  if (!token || typeof token !== "string") {
    console.warn("⚠️ Invalid FCM token, skipping");
    return;
  }

  try {
    await admin.messaging().send({
      token,

      notification: {
        title: String(title),
        body: String(body),
      },

      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "default",
        },
      },

      data: toStringData({
        type,
        ...data,
      }),
    });
  } catch (error) {
    console.error("❌ FCM send error:", error.code, error.message);

    // 🔥 Remove bad tokens automatically
    if (
      error.code === "messaging/invalid-argument" ||
      error.code === "messaging/registration-token-not-registered"
    ) {
      if (userId) {
        await User.findByIdAndUpdate(userId, {
          $unset: { fcmToken: "" },
        });
        console.warn("🧹 Removed invalid FCM token for user:", userId);
      }
    }
  }
};