import multer from "multer";
import path from "path";
import fs from "fs";

// Create folder if doesn't exist
const parcelPhotoFolder = './uploads/parcel_photos';
if (!fs.existsSync(parcelPhotoFolder)) fs.mkdirSync(parcelPhotoFolder, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, parcelPhotoFolder),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const uploadParcelPhoto = multer({ storage });

export default uploadParcelPhoto;
