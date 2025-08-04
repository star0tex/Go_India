import { Router }     from 'express';
import { createFare } from '../controllers/fareController.js';

const router = Router();

// POST  /api/fares/calc
router.post('/calc', createFare);
router.get('/ping', (req, res) => res.json({ ok: true }));
export default router;
