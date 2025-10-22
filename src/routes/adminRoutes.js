import express from "express";
import { verifyAdminToken } from "../middlewares/adminAuth.js";
import {
  // Dashboard
  getDashboardStats,

  // Auth
  adminLogin,

  // Trips
  manualAssignDriver,
  getTripDetails,
  getAllTrips,
  markTripCompleted,
  cancelTrip,

  // Users
  getAllDrivers,
  getAllCustomers,
  blockCustomer,
  unblockCustomer,
  blockDriver,
  unblockDriver,

  // Push Notification
  sendPushToUsers,
  sendPushToIndividual,

  // Documents
  getDriverDocuments,
  verifyDriverDocument,
  getPendingDocuments,
  getDocumentById,
} from "../controllers/adminController.js";

const router = express.Router();

// 🟡 Admin Login (Public)
router.post("/login", adminLogin);

// 🟢 Dashboard Stats
router.get("/stats", verifyAdminToken, getDashboardStats);

// 🧍 Customers
router.get("/customers", verifyAdminToken, getAllCustomers);
router.put("/customer/block/:customerId", verifyAdminToken, blockCustomer);
router.put("/customer/unblock/:customerId", verifyAdminToken, unblockCustomer);

// 🚖 Drivers
router.get("/drivers", verifyAdminToken, getAllDrivers);
router.put("/driver/block/:driverId", verifyAdminToken, blockDriver);
router.put("/driver/unblock/:driverId", verifyAdminToken, unblockDriver);

// 🚘 Trips
router.get("/trips", verifyAdminToken, getAllTrips);
router.post("/manual-assign", verifyAdminToken, manualAssignDriver);
router.get("/trip/:tripId", verifyAdminToken, getTripDetails);
router.put("/trip/:tripId/complete", verifyAdminToken, markTripCompleted);
router.put("/trip/:tripId/cancel", verifyAdminToken, cancelTrip);

// 📨 Push Notifications
router.post("/send-fcm", verifyAdminToken, sendPushToUsers);
router.post("/send-fcm/individual", verifyAdminToken, sendPushToIndividual);

// 📄 Documents
router.get("/documents/pending", verifyAdminToken, getPendingDocuments);
router.get("/documents/:driverId", verifyAdminToken, getDriverDocuments);
router.get("/document/:docId", verifyAdminToken, getDocumentById);
router.put("/verifyDocument/:docId", verifyAdminToken, verifyDriverDocument);

export default router;
