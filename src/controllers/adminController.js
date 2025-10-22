import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Trip from "../models/Trip.js";
import User from "../models/User.js";
import DriverDoc from "../models/DriverDoc.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";
import { verifyAdminToken } from "../middlewares/adminAuth.js";

dotenv.config();

// ======================================================================
// 📊 Dashboard Stats
// ======================================================================
export const getDashboardStats = async (req, res) => {
  try {
    const totalTrips = await Trip.countDocuments();
    const completedTrips = await Trip.countDocuments({ status: "completed" });
    const ongoingTrips = await Trip.countDocuments({ status: "ongoing" });
    const cancelledTrips = await Trip.countDocuments({ status: "cancelled" });

    const totalUsers = await User.countDocuments();
    const totalDrivers = await User.countDocuments({ isDriver: true });
    const totalCustomers = await User.countDocuments({ isDriver: false });

    const pendingDocs = await DriverDoc.countDocuments({ status: "pending" });
    const verifiedDocs = await DriverDoc.countDocuments({ status: "verified" });
    const rejectedDocs = await DriverDoc.countDocuments({ status: "rejected" });

    res.status(200).json({
      message: "Dashboard stats fetched successfully",
      stats: {
        trips: {
          total: totalTrips,
          completed: completedTrips,
          ongoing: ongoingTrips,
          cancelled: cancelledTrips,
        },
        users: {
          total: totalUsers,
          drivers: totalDrivers,
          customers: totalCustomers,
        },
        documents: {
          pending: pendingDocs,
          verified: verifiedDocs,
          rejected: rejectedDocs,
        },
      },
    });
  } catch (err) {
    console.error("❌ Dashboard stats error:", err);
    res.status(500).json({ message: "Server error while fetching stats." });
  }
};

// ======================================================================
// 👥 Users: Drivers & Customers
// ======================================================================
export const getAllDrivers = async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true }).select("-password");
    res.status(200).json({ message: "Drivers fetched successfully", drivers });
  } catch (err) {
    console.error("❌ Error fetching drivers:", err);
    res.status(500).json({ message: "Server error while fetching drivers." });
  }
};

export const getAllCustomers = async (req, res) => {
  try {
    const customers = await User.find({ isDriver: false }).select("-password");
    res.status(200).json({ message: "Customers fetched successfully", customers });
  } catch (err) {
    console.error("❌ Error fetching customers:", err);
    res.status(500).json({ message: "Server error while fetching customers." });
  }
};

export const blockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: true });
    res.status(200).json({ message: "Driver blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking driver:", err);
    res.status(500).json({ message: "Error blocking driver." });
  }
};

export const unblockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: false });
    res.status(200).json({ message: "Driver unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking driver:", err);
    res.status(500).json({ message: "Error unblocking driver." });
  }
};

export const blockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: true });
    res.status(200).json({ message: "Customer blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking customer:", err);
    res.status(500).json({ message: "Error blocking customer." });
  }
};

export const unblockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: false });
    res.status(200).json({ message: "Customer unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking customer:", err);
    res.status(500).json({ message: "Error unblocking customer." });
  }
};

// ======================================================================
// 🚘 Trips
// ======================================================================
export const getAllTrips = async (req, res) => {
  try {
    const trips = await Trip.find({})
      .populate("customerId", "name phone")
      .populate("assignedDriver", "name phone")
      .sort({ createdAt: -1 });
    res.status(200).json({ message: "Trips fetched successfully", trips });
  } catch (err) {
    console.error("❌ Error fetching trips:", err);
    res.status(500).json({ message: "Server error while fetching trips." });
  }
};

export const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const customer = await User.findById(trip.customerId).lean();
    const driver = trip.assignedDriver ? await User.findById(trip.assignedDriver).lean() : null;

    res.status(200).json({
      trip,
      customer: customer
        ? { name: customer.name, phone: customer.phone, address: customer.address || "N/A" }
        : null,
      driver: driver
        ? { name: driver.name, phone: driver.phone, license: driver.license || "N/A" }
        : null,
    });
  } catch (err) {
    console.error("❌ Trip detail fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const manualAssignDriver = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const driver = await User.findById(driverId);
    if (!driver || !driver.isDriver)
      return res.status(404).json({ message: "Driver not found or invalid" });

    trip.assignedDriver = driverId;
    trip.status = "assigned";
    await trip.save();

    if (driver.fcmToken) {
      await sendToDriver(driver.fcmToken, "New Trip Assigned", "You have a new trip assignment.");
    }

    res.status(200).json({ message: "Driver assigned successfully", trip });
  } catch (err) {
    console.error("❌ Manual assign error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const markTripCompleted = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "completed" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip marked as completed", trip });
  } catch (err) {
    console.error("❌ Error marking trip completed:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const cancelTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "cancelled" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip cancelled successfully", trip });
  } catch (err) {
    console.error("❌ Error cancelling trip:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 📨 Push Notifications
// ======================================================================
export const sendPushToUsers = async (req, res) => {
  try {
    const { title, body, role } = req.body;
    const filter = role ? { isDriver: role === "driver" } : {};
    const users = await User.find(filter);

    let count = 0;
    for (const user of users) {
      if (user.fcmToken) {
        if (role === "driver") await sendToDriver(user.fcmToken, title, body);
        else await sendToCustomer(user.fcmToken, title, body);
        count++;
      }
    }
    res.status(200).json({ message: `Push sent to ${count} user(s).` });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ message: "Failed to send push." });
  }
};

// 🆕 Individual Push Notification
export const sendPushToIndividual = async (req, res) => {
  try {
    const { title, body, userId } = req.body;
    const user = await User.findById(userId);
    if (!user || !user.fcmToken) {
      return res.status(404).json({ message: "User not found or no FCM token." });
    }

    if (user.isDriver) {
      await sendToDriver(user.fcmToken, title, body);
    } else {
      await sendToCustomer(user.fcmToken, title, body);
    }

    res.status(200).json({ message: `Push sent to ${user.name}` });
  } catch (err) {
    console.error("❌ Push error (individual):", err);
    res.status(500).json({ message: "Failed to send push." });
  }
};

// ======================================================================
// 📄 Documents
// ======================================================================
export const getPendingDocuments = async (req, res) => {
  try {
    const documents = await DriverDoc.find({ status: "pending" })
      .populate("userId", "name")
      .sort({ createdAt: 1 });
    res.status(200).json({ message: "Pending documents fetched successfully.", documents });
  } catch (err) {
    console.error("❌ Error fetching pending documents:", err);
    res.status(500).json({ message: "Server error." });
  }
};

export const getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;
    const documents = await DriverDoc.find({ userId: driverId });
    if (!documents || documents.length === 0)
      return res.status(404).json({ message: "No documents found for this driver." });

    res.status(200).json({ message: "Documents retrieved successfully.", documents });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    res.status(500).json({ message: "Server error while fetching documents." });
  }
};

export const getDocumentById = async (req, res) => {
  try {
    const { docId } = req.params;
    const document = await DriverDoc.findById(docId).populate("userId", "name email");
    if (!document) return res.status(404).json({ message: "Document not found." });

    res.status(200).json({ message: "Document details fetched successfully.", document });
  } catch (err) {
    console.error("❌ Error fetching document by ID:", err);
    res.status(500).json({ message: "Server error." });
  }
};

export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'verified' or 'rejected'." });
    }

    const updatedDoc = await DriverDoc.findByIdAndUpdate(
      docId,
      { status, remarks },
      { new: true }
    );
    if (!updatedDoc) return res.status(404).json({ message: "Document not found." });

    res.status(200).json({ message: `Document ${status} successfully.`, document: updatedDoc });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    res.status(500).json({ message: "Server error while verifying document." });
  }
};

// ======================================================================
// 🔐 Admin Login
// ======================================================================
export const adminLogin = async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1d" });
    return res.status(200).json({ token });
  } else {
    return res.status(401).json({ message: "Invalid email or password." });
  }
};
