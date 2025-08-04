import express from 'express';
import multer from 'multer';
import { createParcel, estimateParcel } from '../controllers/parcelController.js';
import uploadParcelPhoto from "../middlewares/uploadParcelPhoto.js";

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/estimate', estimateParcel);
router.post("/create", uploadParcelPhoto.single("parcelPhoto"), createParcelRequest);// <- this must match!

export default router;
