// src/controllers/notificationController.js
import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { sendFCMToDriver, sendFCMToCustomer } from "../utils/fcmSender.js";

/**
 * 🔔 Save notification in DB (COMMON)
 */
const createNotification = async ({
  userId,
  role,
  title,
  body,
  type = "general",
  data = {},
}) => {
  try {
    await Notification.create({
      userId,
      role,
      title,
      body,
      type,
      data,
    });
  } catch (err) {
    console.error("❌ Failed to save notification:", err.message);
  }
};

/**
 * 🚗 Sends trip-related notifications
 */
const sendTripNotification = async (to, type, tripId) => {
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) return;

    // ================= DRIVER =================
    if (to === "driver") {
      const driver = await User.findById(trip.assignedDriver);
      if (!driver) return;

      let title = "";
      let body = "";

      if (type === "new_request") {
        title = "New Trip Request";
        body = "You have a new trip request.";
      } else if (type === "reassigned") {
        title = "Trip Reassigned";
        body = "You have been reassigned to a trip.";
      }

      // ✅ SAVE TO DB
      await createNotification({
        userId: driver._id,
        role: "driver",
        title,
        body,
        type: "trip",
        data: { tripId },
      });

      // ✅ SEND FCM
      if (driver.fcmToken) {
        await sendFCMToDriver(driver.fcmToken, {
          title,
          body,
          data: {
            tripId: trip._id.toString(),
            pickup: trip.pickup,
            drop: trip.drop,
            vehicleType: trip.vehicleType,
          },
        });
      }
    }

    // ================= CUSTOMER =================
    if (to === "customer") {
      const customer = await User.findById(trip.customerId);
      if (!customer) return;

      let title = "";
      let body = "";

      if (type === "accepted") {
        title = "Driver Confirmed";
        body = "Your driver has accepted the trip.";
      } else if (type === "cancelled") {
        title = "Trip Cancelled";
        body = "Your trip has been cancelled.";
      }

      // ✅ SAVE TO DB
      await createNotification({
        userId: customer._id,
        role: "customer",
        title,
        body,
        type: "trip",
        data: { tripId },
      });

      // ✅ SEND FCM
      if (customer.fcmToken) {
        await sendFCMToCustomer(customer.fcmToken, {
          title,
          body,
          data: { tripId: trip._id.toString() },
        });
      }
    }
  } catch (err) {
    console.error("❌ Error in sendTripNotification:", err);
  }
};

/**
 * 📢 Admin manual notification
 */
const sendManualNotification = async (req, res) => {
  try {
    const { title, body, userType } = req.body;

    const users = await User.find(
      userType === "driver" ? { isDriver: true } : { isDriver: false }
    );

    for (const user of users) {
      // ✅ SAVE
      await createNotification({
        userId: user._id,
        role: user.isDriver ? "driver" : "customer",
        title,
        body,
        type: "general",
      });

      // ✅ FCM
      if (user.fcmToken) {
        user.isDriver
          ? await sendFCMToDriver(user.fcmToken, { title, body })
          : await sendFCMToCustomer(user.fcmToken, { title, body });
      }
    }

    res.status(200).json({
      success: true,
      message: `Notification sent to ${users.length} ${userType}s`,
    });
  } catch (err) {
    console.error("❌ sendManualNotification error:", err);
    res.status(500).json({ success: false });
  }
};

/**
 * 🔁 Reassignment notification
 */
const sendReassignmentNotification = async (driverId, tripId) => {
  try {
    const driver = await User.findById(driverId);
    if (!driver) return;

    // ✅ SAVE
    await createNotification({
      userId: driver._id,
      role: "driver",
      title: "Trip Reassigned",
      body: "You have been reassigned to a trip.",
      type: "trip",
      data: { tripId },
    });

    // ✅ FCM
    if (driver.fcmToken) {
      await sendFCMToDriver(driver.fcmToken, {
        title: "Trip Reassigned",
        body: "You have been reassigned to a trip.",
        data: { tripId },
      });
    }
  } catch (err) {
    console.error("❌ sendReassignmentNotification error:", err);
  }
};

export {
  sendTripNotification,
  sendManualNotification,
  sendReassignmentNotification,
};