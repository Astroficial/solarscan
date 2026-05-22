import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});
console.log('Cloudinary cloud_name:', process.env.CLOUDINARY_CLOUD_NAME);
console.log('Cloudinary api_key:', process.env.CLOUDINARY_API_KEY);
console.log('Cloudinary secret length:', process.env.CLOUDINARY_API_SECRET?.length);
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── CONFIG ────────────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'static')));

// ── CLOUDINARY ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log('Cloudinary cloud_name:', process.env.CLOUDINARY_CLOUD_NAME);
console.log('Cloudinary api_key:', process.env.CLOUDINARY_API_KEY);
console.log('Cloudinary secret length:', process.env.CLOUDINARY_API_SECRET?.length);

// ── OPENAI ────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── TEMP DIR ──────────────────────────────────────────────────────────────────
const TMP = '/tmp/solarquote';
fs.mkdirSync(TMP, { recursive: true });

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getPanelLayout(count) {
  if (count <= 12) return { rows: 2, cols: Math.ceil(count / 2) };
  if (count <= 21) return { rows: 3, cols: Math.ceil(count / 3) };
  return { rows: 4, cols: Math.ceil(count / 4) };
}

function buildPrompt(systemKw, panelCount, legHeightsFt, roofType) {
  const layout     = getPanelLayout(panelCount);
  const avgLeg     = legHeightsFt.length
    ? (legHeightsFt.reduce((a, b) => a + b, 0) / legHeightsFt.length).toFixed(1)
    : 3.0;

  return (
    `Edit the uploaded actual roof photograph by installing a realistic Indian rooftop solar panel system inside the marked yellow polygon area. ` +
    `The yellow polygon shows the exact panel plane selected by the engineer. ` +
    `Install a ${systemKw} kW rooftop solar system using exactly ${panelCount} separate solar panels arranged in ${layout.rows} rows x ${layout.cols} columns. ` +
    `Every panel must be clearly separate and countable. Each panel must have its own visible aluminum frame, clear gap from adjacent panels, and realistic blue photovoltaic cell texture. Do not merge panels into one large sheet. ` +
    `Mount the panels on realistic elevated Indian rooftop GI/MS support structure with visible rails, braces, clamps, cross members, and RCC concrete pedestal blocks. ` +
    `Support marking rule: If red support guide lines are visible in the image, use them as the exact guidance for extended support rods. Extend realistic GI/MS support rods from the solar panel frame down to the marked roof footing points. Place RCC concrete blocks at the base. The panels must not appear floating. ` +
    `If the panel polygon is visually higher than the roof surface, automatically add long support rods down to the nearest visible rooftop surface and place RCC concrete footing blocks below them. ` +
    `The average support leg height required is approximately ${avgLeg} feet. This is a raised structure at 25-30 degree tilt angle. ` +
    `Orientation rule: The camera was pointing NORTH when this photo was taken. Therefore all solar panels must face TRUE SOUTH which means panels face DIRECTLY TOWARD THE CAMERA in this image. The full front glass surface of all panels must be visible to the viewer. ` +
    `Preserve the original roof photo completely. Do not change roof geometry, parapet walls, vents, tanks, AC units, pipes, trees, towers, buildings, sky, or background. Do not distort the original camera perspective. Do not remove stains, cracks, weathering, or rooftop texture. ` +
    `Lighting and shadows: match the original sunlight direction. Add realistic shadows under panels, support rods, frames, and RCC blocks. Shadows must fall naturally on the roof surface. Panel reflections should be subtle not mirror-like. ` +
    `Electrical details: add subtle DC cable routing under the panels. Add one small inverter or junction box near a wall only if it fits naturally. Keep wiring minimal and realistic. ` +
    `Final output: A realistic Indian rooftop solar EPC proposal image showing exactly ${panelCount} separate panels installed inside the marked polygon, with extended support rods and RCC footing blocks wherever marked. ` +
    `Strict negative instructions: do not create one continuous solar sheet. Do not merge panels. Do not change exact panel count. Do not ignore red support guide lines. Do not create floating panels. Do not paste another image. Do not distort roof or background. Do not add unrelated objects.`
  );
}

function calcFinancials(systemKw, monthlyBill, quotedPrice, subsidyAmount) {
  const netCost      = quotedPrice - subsidyAmount;
  const yearlyKwh    = systemKw * 1500;
  const unitRate     = Math.max(6, Math.min((monthlyBill * 12) / Math.max(yearlyKwh, 1), 12));
  const annualSaving = Math.round(yearlyKwh * unitRate);
  const payback      = (netCost / Math.max(annualSaving, 1)).toFixed(1);
  const saving25yr   = Math.round((annualSaving * 25) - netCost);
  const monthlyAfter = Math.max(0, Math.round(monthlyBill - annualSaving / 12));
  const savePct      = Math.round(((monthlyBill - monthlyAfter) / monthlyBill) * 100);
  const co2          = ((yearlyKwh * 0.82) / 1000).toFixed(1);
  const trees        = Math.round(yearlyKwh * 0.82 / 1000 * 24);

  return {
    systemKw,
    quotedPrice,
    subsidyAmount,
    netCost,
    yearlyKwh,
    annualSaving,
    payback,
    saving25yr,
    monthlyBefore: monthlyBill,
    monthlyAfter,
    savePct,
    co2,
    trees,
    advance:  Math.round(netCost * 0.20),
    material: Math.round(netCost * 0.70),
    final:    Math.round(netCost * 0.10),
  };
}

// ── CLOUDINARY UPLOAD ─────────────────────────────────────────────────────────
async function uploadToCloudinary(buffer, folder, publicId) {
  const timestamp   = Math.round(Date.now() / 1000);
  const apiSecret   = process.env.CLOUDINARY_API_SECRET;
  const apiKey      = process.env.CLOUDINARY_API_KEY;
  const cloudName   = process.env.CLOUDINARY_CLOUD_NAME;

  // Build string to sign
  const paramStr = `folder=${folder}&overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha256')
    .update(paramStr + apiSecret)
    .digest('hex');

  const formData = new FormData();
  formData.append('file',       new Blob([buffer], { type: 'image/jpeg' }), 'upload.jpg');
  formData.append('folder',     folder);
  formData.append('public_id',  publicId);
  formData.append('overwrite',  'true');
  formData.append('timestamp',  String(timestamp));
  formData.append('api_key',    apiKey);
  formData.append('signature',  signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );

  const data = await response.json();
  if (data.error) throw new Error('Cloudinary: ' + data.error.message);
  return data.secure_url;
}

// ── INSTALLER PROFILE SAVE ────────────────────────────────────────────────────
app.post('/api/save-profile', upload.fields([
  { name: 'logo',     maxCount: 1 },
  { name: 'project0', maxCount: 1 }, { name: 'project1', maxCount: 1 },
  { name: 'project2', maxCount: 1 }, { name: 'project3', maxCount: 1 },
  { name: 'project4', maxCount: 1 }, { name: 'project5', maxCount: 1 },
]), async (req, res) => {
  try {
    const installerId = req.body.installer_id || 'default';
    const profile     = JSON.parse(req.body.profile_json || '{}');

    // Upload logo
    if (req.files?.logo?.[0]) {
      profile.logo_url = await uploadToCloudinary(
        req.files.logo[0].buffer, `solarquote/${installerId}`, 'logo'
      );
    }

    // Upload project photos
    profile.projects = profile.projects || [];
    for (let i = 0; i < 6; i++) {
      const key  = `project${i}`;
      const meta = profile.projects[i] || {};
      if (req.files?.[key]?.[0]) {
        meta.photo_url = await uploadToCloudinary(
          req.files[key][0].buffer, `solarquote/${installerId}/projects`, `project_${i}`
        );
      }
      profile.projects[i] = meta;
    }

    // Save profile JSON to /tmp
    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    res.json({ success: true, profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── INSTALLER PROFILE LOAD ────────────────────────────────────────────────────
app.get('/api/load-profile', (req, res) => {
  try {
    const installerId = req.query.installer_id || 'default';
    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      res.json({ success: true, profile });
    } else {
      res.json({ success: true, profile: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAIN QUOTE GENERATION ─────────────────────────────────────────────────────
app.post('/api/generate-quote', upload.single('photo'), async (req, res) => {
  const jobId  = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // Parse inputs
    const systemKw      = parseFloat(req.body.system_kw     || 5);
    const panelWatt     = parseInt(req.body.panel_watt       || 550);
    const panelCount    = Math.ceil((systemKw * 1000) / panelWatt);
    const quotedPrice   = parseInt(req.body.quoted_price     || 325000);
    const subsidyAmount = parseInt(req.body.subsidy_amount   || 78000);
    const monthlyBill   = parseInt(req.body.monthly_bill     || 3000);
    const roofType      = req.body.roof_type                 || 'flat_rcc';
    const panelBrand    = req.body.panel_brand               || 'Waaree Solar';
    const inverterBrand = req.body.inverter_brand            || 'Solis';
    const legHeights    = JSON.parse(req.body.leg_heights_ft || '[3]');
    const installerId   = req.body.installer_id              || 'default';

    // Customer
    const customer = {
      name:    req.body.customer_name    || 'Homeowner',
      phone:   req.body.customer_phone   || '',
      address: req.body.customer_address || '',
    };

    // Load installer profile
    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    const installer   = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8'))
      : {
          company_name:   req.body.installer_name  || 'Solar Installer',
          phone:          req.body.installer_phone || '',
          email:          req.body.installer_email || '',
          website:        '',
          address:        '',
          gst:            '',
          years:          '5+',
          total_kw:       '500+',
          bank_name:      '',
          account_no:     '',
          ifsc:           '',
          upi:            '',
          logo_url:       '',
          projects:       [],
        };

// Save marked photo
const photoPath = path.join(jobDir, 'roof_marked.jpg');
fs.writeFileSync(photoPath, req.file.buffer);

// Verify it is a valid image by checking buffer
console.log(`Photo size: ${req.file.buffer.length} bytes, mimetype: ${req.file.mimetype}`);

    // Generate AI image
    console.log(`Job ${jobId}: Generating AI image...`);
    const prompt   = buildPrompt(systemKw, panelCount, legHeights, roofType);
const { toFile } = await import('openai');
const imageFile = await toFile(
  fs.createReadStream(photoPath),
  'roof_marked.jpg',
  { type: 'image/jpeg' }
);

const aiResult = await openai.images.edit({
  model:  'gpt-image-1',
  image:  imageFile,
  prompt,
  n:      1,
  size:   '1024x1024',
});

    const imageBuffer  = Buffer.from(aiResult.data[0].b64_json, 'base64');
    const resultPath   = path.join(jobDir, 'result.jpg');
    fs.writeFileSync(resultPath, imageBuffer);

    // Upload AI image to Cloudinary
    const aiImageUrl = await uploadToCloudinary(
      imageBuffer, `solarquote/results`, `result_${jobId}`
    );

    // Calculate financials
    const fin = calcFinancials(systemKw, monthlyBill, quotedPrice, subsidyAmount);

    // Generate PDF via Puppeteer
    console.log(`Job ${jobId}: Generating PDF...`);
    const pdfPath = path.join(jobDir, 'proposal.pdf');
    await generatePDF({
      installer, customer, fin,
      panelBrand, inverterBrand, panelCount,
      aiImageUrl, jobId, pdfPath
    });

    // Upload PDF to Cloudinary
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfUrl    = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:        `solarquote/pdfs`,
          public_id:     `proposal_${jobId}`,
          resource_type: 'raw',
          format:        'pdf',
        },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      stream.end(pdfBuffer);
    });

    res.json({
      success:   true,
      job_id:    jobId,
      image_url: aiImageUrl,
      pdf_url:   pdfUrl,
      financials: fin,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup job dir after 10 minutes
    setTimeout(() => fs.rmSync(jobDir, { recursive: true, force: true }), 600000);
  }
});

// ── PDF GENERATION ────────────────────────────────────────────────────────────
async function generatePDF({ installer, customer, fin, panelBrand, inverterBrand, panelCount, aiImageUrl, jobId, pdfPath }) {

  const today    = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const validDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const proposalNo = `SP-${new Date().getFullYear()}-${jobId.toUpperCase()}`;

  // Build project cards HTML
  const projects     = installer.projects || [];
  const projectCards = (p, idx) => {
    if (!p) return '';
    const bgImg = p.photo_url
      ? `background-image:url('${p.photo_url}');background-size:cover;background-position:center;`
      : `background:linear-gradient(135deg,#1B5E20,#2E7D32);`;
    return `
      <div style="flex:1;background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;display:flex;flex-direction:column;">
        <div style="height:220px;position:relative;${bgImg}display:flex;flex-direction:column;align-items:center;justify-content:center;">
          ${!p.photo_url ? `
            <div style="position:absolute;inset:0;background:linear-gradient(135deg,rgba(27,94,32,0.8),rgba(46,125,50,0.8));"></div>
            <div style="position:relative;z-index:2;text-align:center;color:white;">
              <div style="font-size:40px;margin-bottom:8px;">📷</div>
              <div style="font-size:22px;font-weight:900;">${p.name || 'Project ' + (idx+1)}</div>
              <div style="font-size:13px;margin-top:4px;">📍 ${p.city || ''}</div>
            </div>
          ` : `
            <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.6),transparent);"></div>
            <div style="position:absolute;bottom:16px;left:16px;right:16px;color:white;">
              <div style="font-size:20px;font-weight:900;">${p.name || ''}</div>
              <div style="font-size:12px;margin-top:2px;">📍 ${p.city || ''}</div>
            </div>
          `}
        </div>
        <div style="padding:20px;flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
            <span style="background:#F9A825;color:#1B5E20;font-size:11px;font-weight:900;padding:4px 12px;border-radius:20px;">${p.capacity || '5 kW'} System</span>
            <span style="background:#F1F8E9;color:#2E7D32;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;border:1px solid #C8E6C9;">${p.roof || 'Flat RCC'}</span>
          </div>
          <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:8px;">⚡ ${p.kwh || '7,500 kWh/year'} estimated</div>
          <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:8px;">📅 Installed: ${p.date || '2025'}</div>
          <div style="font-size:12px;color:#4A6741;font-weight:700;">⭐ Rating: ${p.rating || '4.9/5'}</div>
          ${p.quote ? `
            <div style="margin-top:auto;border-top:1px solid #C8E6C9;padding-top:12px;">
              <div style="font-size:11px;color:#4A6741;font-style:italic;">"${p.quote}"</div>
              <div style="font-size:10px;color:#2E7D32;font-weight:900;margin-top:4px;">— ${p.quote_author || ''}</div>
            </div>
          ` : ''}
        </div>
      </div>`;
  };

  const proj0 = projectCards(projects[0], 0);
  const proj1 = projectCards(projects[1], 1);
  const proj2 = projectCards(projects[2], 2);
  const proj3 = projectCards(projects[3], 3);
  const proj4 = projectCards(projects[4], 4);
  const proj5 = projectCards(projects[5], 5);

  // Monthly generation data
  const monthlyData = [
    {m:'Jan',v:450},{m:'Feb',v:520},{m:'Mar',v:650},{m:'Apr',v:720},
    {m:'May',v:750},{m:'Jun',v:750},{m:'Jul',v:600},{m:'Aug',v:550},
    {m:'Sep',v:580},{m:'Oct',v:620},{m:'Nov',v:500},{m:'Dec',v:450}
  ];
  const maxV = 750;
  const chartBars = monthlyData.map(d => `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;">
      <div style="width:100%;max-width:18px;height:${Math.round((d.v/maxV)*80)}px;background:linear-gradient(to top,#8BC34A,#1B5E20);border-radius:2px 2px 0 0;"></div>
      <div style="font-size:8px;font-weight:700;color:#4A6741;margin-top:4px;">${d.m}</div>
    </div>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: white; }
  .page {
    width: 210mm;
    min-height: 297mm;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    display: flex;
    flex-direction: column;
  }
  @media print {
    .page { page-break-after: always; }
    body { margin: 0; }
  }
  .page-footer {
    position: absolute;
    bottom: 20px;
    right: 40px;
    font-size: 9px;
    font-weight: 700;
    color: #4A6741;
    letter-spacing: 1px;
    text-transform: uppercase;
    opacity: 0.6;
  }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 0; }
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 0: INTRO -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#1A2F1A;">

  <!-- Dot pattern -->
  <div style="position:absolute;inset:0;opacity:0.08;background-image:radial-gradient(#fff 1.5px,transparent 1.5px);background-size:16px 16px;pointer-events:none;"></div>

  <!-- Top image section -->
  <div style="position:relative;height:48%;width:100%;">
    <!-- Yellow triangle top left -->
    <div style="position:absolute;top:0;left:0;width:45%;height:96px;background:#F9A825;clip-path:polygon(0 0,100% 0,0 100%);z-index:2;"></div>
    <!-- Green logo box top right -->
    <div style="position:absolute;top:0;right:0;width:45%;height:128px;background:#2E7D32;clip-path:polygon(20% 0,100% 0,100% 100%,0 100%);z-index:2;display:flex;align-items:flex-start;justify-content:flex-end;padding:28px;">
      <div style="text-align:right;color:white;display:flex;align-items:center;gap:12px;">
        <div>
          <div style="font-weight:900;font-size:18px;line-height:1;">SURYA</div>
          <div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;opacity:0.9;">Company</div>
        </div>
        <div style="width:40px;height:40px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;">🌿</div>
      </div>
    </div>
    <!-- Yellow right accent -->
    <div style="position:absolute;top:80px;right:0;width:96px;height:100%;background:#F9A825;clip-path:polygon(100% 0,100% 100%,0 40%);z-index:0;"></div>
    <!-- Solar image -->
    <div style="position:absolute;inset:0;z-index:1;background:#1B5E20;border-radius:0 0 96px 0;overflow:hidden;">
      <img src="https://images.unsplash.com/photo-1509391366360-2e959784a276?auto=format&fit=crop&w=1200&q=80"
           style="width:100%;height:100%;object-fit:cover;object-position:bottom;" />
      <div style="position:absolute;inset:0;background:rgba(27,94,32,0.2);"></div>
    </div>
  </div>

  <!-- Text section -->
  <div style="padding:24px 48px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="text-align:right;margin-top:16px;">
      <div style="font-size:60px;font-weight:900;font-style:italic;color:white;line-height:0.85;letter-spacing:-2px;transform:skewX(-6deg);display:inline-block;">Sustainable</div><br/>
      <div style="font-size:60px;font-weight:900;font-style:italic;color:#F9A825;line-height:0.85;letter-spacing:-2px;transform:skewX(-6deg);display:inline-block;margin-top:8px;">Energy Future</div>
      <div style="color:#C8E6C9;font-size:13px;margin-top:20px;max-width:280px;margin-left:auto;line-height:1.6;">Invest in advanced solar technology, enhancing your property's value while embracing sustainable living.</div>
    </div>

    <div style="margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:flex-end;">
      <div>
        <div style="color:white;font-weight:700;font-size:20px;margin-bottom:16px;">Contact Us:</div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="width:24px;height:24px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;">📞</div>
          <span style="color:white;font-weight:600;">${installer.phone || '+91 98765 43210'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
          <div style="width:24px;height:24px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;">📷</div>
          <span style="color:white;font-weight:600;">${installer.website || '@suryapower'}</span>
        </div>
        <div style="background:#F9A825;color:#1A2F1A;font-weight:900;text-transform:uppercase;letter-spacing:2px;font-size:12px;padding:10px 28px;display:inline-block;border-radius:4px;">Learn More</div>
      </div>

      <div style="text-align:right;">
        <div style="color:white;font-weight:700;font-size:20px;margin-bottom:16px;">Our Service 🌱</div>
        ${['Energy Consultation','System Maintenance','Solar Panel Installation','Battery & Inverter Setup'].map(s => `
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:12px;">
            <span style="color:#C8E6C9;font-weight:600;font-size:13px;">${s}</span>
            <div style="width:20px;height:20px;background:#8BC34A;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:10px;flex-shrink:0;">✓</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 1: COVER -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">

  <!-- Green top blob -->
  <div style="position:absolute;top:0;left:0;width:100%;height:55%;background:#1B5E20;border-radius:0 0 96px 96px;z-index:0;"></div>

  <div style="padding:48px;display:flex;flex-direction:column;height:100%;position:relative;z-index:1;">

    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;">
      <div style="display:flex;align-items:center;gap:10px;color:white;">
        ${installer.logo_url
          ? `<img src="${installer.logo_url}" style="height:40px;width:40px;border-radius:50%;object-fit:cover;" />`
          : `<span style="font-size:28px;">🌿</span>`
        }
        <div>
          <div style="font-weight:900;font-size:20px;line-height:1;">${installer.company_name || 'SURYA POWER'}</div>
          <div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;opacity:0.8;">Solutions</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="color:#C8E6C9;font-size:12px;">Proposal No: ${proposalNo}</div>
        <div style="color:#C8E6C9;font-size:12px;">Date: ${today}</div>
        <div style="color:#C8E6C9;font-size:12px;">Valid Until: ${validDate}</div>
      </div>
    </div>

    <!-- Title -->
    <div style="margin-bottom:24px;">
      <div style="color:#F9A825;font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:13px;margin-bottom:12px;">🌿 India's Trusted Rooftop Solar EPC</div>
      <div style="font-size:52px;font-weight:900;color:white;line-height:1.1;">CLEAN ENERGY<br/>PROPOSAL</div>
    </div>

    <!-- AI Roof Image — LARGE -->
    <div style="flex:1;width:100%;border:4px solid #8BC34A;border-radius:24px;overflow:hidden;position:relative;min-height:200px;">
      <img src="${aiImageUrl}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.3),transparent);"></div>
    </div>

    <!-- Client info -->
    <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;">
      <div style="background:white;padding:20px 24px;border-radius:16px;border:1px solid #C8E6C9;flex:1;max-width:400px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;right:0;width:60px;height:60px;background:#E8F5E9;border-radius:0 0 0 100%;"></div>
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Prepared Exclusively For:</div>
        <div style="font-size:20px;font-weight:900;color:#1A2F1A;margin-bottom:4px;">${customer.name}</div>
        <div style="font-size:12px;color:#4A6741;margin-bottom:12px;">${customer.address || ''}</div>
        <div style="height:1px;background:#C8E6C9;margin-bottom:12px;"></div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">System Size: <span style="color:#F9A825;font-weight:900;font-size:16px;background:#1B5E20;padding:2px 10px;border-radius:6px;">${fin.systemKw} kW</span></div>
      </div>

      <div style="text-align:right;">
        <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;margin-bottom:16px;">
          <span style="font-size:16px;">☀️</span>
          <span style="font-weight:700;color:#1B5E20;font-size:13px;">PM Surya Ghar: Muft Bijli Yojana</span>
          <span style="color:#8BC34A;">✓</span>
        </div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">🌐 ${installer.website || 'www.suryapower.com'}</div>
        <div style="font-size:13px;color:#4A6741;margin-top:4px;">📞 ${installer.phone || '98765 43210'}</div>
      </div>
    </div>
  </div>
  <div class="page-footer">Page 1 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 2: WELCOME LETTER -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;padding:48px;">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid #1B5E20;padding-bottom:20px;margin-bottom:40px;">
    <div style="display:flex;align-items:center;gap:10px;color:#1B5E20;">
      ${installer.logo_url
        ? `<img src="${installer.logo_url}" style="height:36px;width:36px;border-radius:50%;object-fit:cover;" />`
        : `<span style="font-size:24px;">🌿</span>`
      }
      <div>
        <div style="font-weight:900;font-size:18px;">${installer.company_name || 'SURYA POWER'}</div>
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;">Solutions</div>
      </div>
    </div>
    <div style="text-align:right;font-size:12px;color:#4A6741;font-weight:600;">
      <div>${today}</div><div>Ref: ${proposalNo}</div>
    </div>
  </div>

  <div style="font-size:26px;font-weight:900;color:#1A2F1A;margin-bottom:28px;">Dear ${customer.name},</div>

  <!-- PM Surya Ghar Banner -->
  <div style="background:linear-gradient(to right,#FFF8E1,#F1F8E9);border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;gap:16px;margin-bottom:28px;position:relative;overflow:hidden;">
    <div style="width:56px;height:56px;background:white;border-radius:50%;border:3px solid #F9A825;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;">☀️</div>
    <div>
      <div style="font-size:18px;font-weight:900;color:#1B5E20;">PM Surya Ghar: Muft Bijli Yojana</div>
      <div style="font-size:12px;font-weight:700;color:#2E7D32;margin-top:2px;">Empanelled & Authorized Vendor</div>
    </div>
    <div style="margin-left:auto;background:linear-gradient(to right,#F9A825,#FF8F00);color:white;font-weight:900;padding:8px 16px;border-radius:10px;font-size:12px;transform:rotate(2deg);">SUBSIDY READY</div>
  </div>

  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">
    Welcome to <strong style="color:#1B5E20;">${installer.company_name || 'Surya Power Solutions'}</strong>! We are excited to present your customized <strong>${fin.systemKw} kW solar system</strong> design. As an authorized PM Surya Ghar partner with over ${installer.years || '8'} years of excellence, we ensure a seamless transition to clean, affordable energy using only premium Tier-1 components.
  </div>
  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">
    This proposal outlines your exact system specifications, financial savings, and the straightforward roadmap to claiming your <strong style="color:#1B5E20;">₹${fin.subsidyAmount.toLocaleString('en-IN')}</strong> government subsidy. With this installation, you will drastically cut your monthly bills while locking in energy security for decades.
  </div>
  <div style="font-size:15px;color:#4A6741;line-height:1.8;">
    Please review the detailed projections inside. Our technical team is ready to answer any questions and help you take the next step toward a sustainable future.
  </div>

  <div style="margin-top:32px;color:#1B5E20;font-weight:700;">Warm Regards,</div>
  <div style="font-family:Georgia,serif;font-size:36px;color:#2E7D32;opacity:0.9;margin-top:8px;">${installer.company_name || 'Surya Power'}</div>
  <div style="font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
  <div style="font-size:12px;color:#8BC34A;font-weight:700;">${installer.email || ''}</div>

  <div style="margin-top:auto;padding-top:24px;display:flex;justify-content:center;">
    <div style="background:white;border:1px solid #C8E6C9;border-radius:16px;padding:16px 24px;text-align:center;">
      <div style="font-size:11px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Authorized & Empanelled</div>
      <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;">
        <span>☀️</span><span style="font-weight:700;color:#1B5E20;font-size:13px;">PM Surya Ghar: Muft Bijli Yojana</span><span style="color:#8BC34A;">✓</span>
      </div>
    </div>
  </div>
  <div class="page-footer">Page 2 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 3: PROJECTS Part 1 -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;position:relative;overflow:hidden;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Our Track Record</div>
    <div style="font-size:32px;font-weight:900;">Installer Profile & Past Projects</div>
  </div>

  <div style="padding:32px 48px;display:flex;flex-direction:column;flex:1;">
    <!-- Stats Strip -->
    <div style="background:white;border:2px solid #C8E6C9;border-radius:16px;display:flex;justify-content:space-between;align-items:center;padding:16px 24px;margin-bottom:32px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;width:100%;height:4px;background:linear-gradient(to right,#F9A825,#8BC34A);"></div>
      ${[
        {label:'In Business', value: installer.years || '8+', icon:'📅'},
        {label:'Installations', value: installer.total_kw || '450+', icon:'🏠'},
        {label:'Capacity', value:'2.1 MW', icon:'⚡'},
        {label:'Customer Rating', value:'4.9/5', icon:'⭐'},
      ].map((s,i) => `
        <div style="display:flex;align-items:center;gap:14px;">
          <div style="width:44px;height:44px;background:#E8F5E9;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;">${s.icon}</div>
          <div>
            <div style="font-size:18px;font-weight:900;color:#1B5E20;">${s.value}</div>
            <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${s.label}</div>
          </div>
        </div>
        ${i<3 ? '<div style="width:1px;height:40px;background:#C8E6C9;"></div>' : ''}
      `).join('')}
    </div>

    <!-- 2 Project Cards -->
    <div style="display:flex;gap:24px;flex:1;">
      ${proj0 || projectCards({name:'Project 1',city:'Your City',capacity:'5 kW',roof:'Flat RCC',kwh:'7,500 kWh/year',date:'2025',rating:'4.9/5'},0)}
      ${proj1 || projectCards({name:'Project 2',city:'Your City',capacity:'6 kW',roof:'Elevated Truss',kwh:'9,000 kWh/year',date:'2025',rating:'4.8/5'},1)}
    </div>

    <div style="text-align:center;font-size:11px;color:#4A6741;font-style:italic;margin-top:16px;">📷 Replace placeholder with actual site photo before sharing</div>
  </div>
  <div class="page-footer">Page 3 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 4: PROJECTS Part 2 -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Our Track Record</div>
    <div style="font-size:32px;font-weight:900;">Installer Profile & Past Projects</div>
  </div>
  <div style="padding:32px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;">
      ${proj2 || projectCards({name:'Project 3',city:'Your City',capacity:'5 kW',roof:'Sloped Tile',kwh:'7,600 kWh/year',date:'2024',rating:'5.0/5'},2)}
      ${proj3 || projectCards({name:'Project 4',city:'Your City',capacity:'10 kW',roof:'Industrial Flat',kwh:'15,000 kWh/year',date:'2024',rating:'4.9/5'},3)}
    </div>
    <div style="text-align:center;font-size:11px;color:#4A6741;font-style:italic;margin-top:16px;">📷 Replace placeholder with actual site photo before sharing</div>
  </div>
  <div class="page-footer">Page 4 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 5: PROJECTS Part 3 + Commitments -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Our Track Record</div>
    <div style="font-size:32px;font-weight:900;">Installer Profile & Past Projects</div>
  </div>
  <div style="padding:32px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;margin-bottom:24px;">
      ${proj4 || projectCards({name:'Project 5',city:'Your City',capacity:'8 kW',roof:'GI Truss',kwh:'12,000 kWh/year',date:'2025',rating:'4.7/5'},4)}
      ${proj5 || projectCards({name:'Project 6',city:'Your City',capacity:'5 kW',roof:'Flat Terrace',kwh:'7,500 kWh/year',date:'2025',rating:'4.9/5'},5)}
    </div>
    <div style="text-align:center;font-size:11px;color:#4A6741;font-style:italic;margin-bottom:20px;">📷 Replace placeholder with actual site photo before sharing</div>

    <!-- Commitments -->
    <div style="background:#1B5E20;color:white;border-radius:16px;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
      ${[
        {icon:'✓', label:'MNRE Empanelled', sub:'Installer'},
        {icon:'🛡', label:'Tier-1 Brands Only', sub:'Waaree, Adani, Vikram'},
        {icon:'⚙', label:'5 Year Free AMC', sub:'Included'},
      ].map((c,i) => `
        <div style="display:flex;align-items:center;gap:12px;flex:1;justify-content:center;">
          <div style="background:#8BC34A;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#1B5E20;font-weight:900;font-size:16px;">${c.icon}</div>
          <div style="text-align:center;">
            <div style="font-weight:700;font-size:13px;">${c.label}</div>
            <div style="font-size:10px;opacity:0.8;">${c.sub}</div>
          </div>
        </div>
        ${i<2 ? '<div style="width:1px;height:40px;background:rgba(255,255,255,0.2);"></div>' : ''}
      `).join('')}
    </div>
  </div>
  <div class="page-footer">Page 5 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 6: SYSTEM DESIGN -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Technical Overview</div>
    <div style="font-size:32px;font-weight:900;">Proposed System Design</div>
  </div>
  <div style="padding:32px 48px;">

    <!-- AI Image -->
    <div style="width:100%;height:340px;border-radius:20px;overflow:hidden;border:2px solid #C8E6C9;margin-bottom:24px;position:relative;">
      <img src="${aiImageUrl}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.4),transparent);"></div>
      <div style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:white;font-weight:700;font-size:13px;background:rgba(0,0,0,0.5);padding:6px 16px;border-radius:20px;">AI Generated — Your Actual Roof View</div>
    </div>

    <!-- 4 Spec Cards -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
      ${[
        {title:'System Size', value:`${fin.systemKw} kW`, icon:'⚡'},
        {title:'Solar Panels', value:`${panelCount}x ${panelBrand.split(' ')[0]} 550W`, icon:'☀️'},
        {title:'Orientation', value:'South / 25° Tilt', icon:'📍'},
        {title:'Connection', value:'On-Grid Net Meter', icon:'🔌'},
      ].map(s => `
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
          <div style="font-size:22px;margin-bottom:8px;">${s.icon}</div>
          <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${s.title}</div>
          <div style="font-size:14px;font-weight:900;color:#1A2F1A;">${s.value}</div>
        </div>
      `).join('')}
    </div>

    <!-- CO2 Banner -->
    <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="background:linear-gradient(135deg,#8BC34A,#2E7D32);padding:14px;border-radius:50%;font-size:24px;">🌿</div>
        <div>
          <div style="font-size:17px;font-weight:900;color:#1B5E20;">Environmental Impact</div>
          <div style="font-size:13px;font-weight:700;color:#4A6741;">Offsets ${fin.co2} Tonnes of CO₂ emissions annually</div>
        </div>
      </div>
      <div style="background:#F1F8E9;padding:12px 16px;border-radius:12px;border:1px solid #C8E6C9;text-align:right;">
        <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;">Equivalent to planting</div>
        <div style="font-size:26px;font-weight:900;color:#1B5E20;">${fin.trees} Trees / Year</div>
      </div>
    </div>

    <!-- Tech Table -->
    <div style="background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;">
      <div style="background:#1B5E20;padding:12px 20px;color:white;font-weight:700;font-size:14px;">⚙ Detailed Specifications</div>
      ${[
        ['System Type', 'Grid-Tied (On-Grid) Rooftop Solar PV System'],
        ['Panel Model', `${panelBrand} 550W Monocrystalline PERC Half-Cut`],
        ['Inverter Model', `${inverterBrand} ${fin.systemKw}kW String Inverter (Wi-Fi Enabled)`],
        ['Mounting Structure', 'Hot-Dip Galvanized (HDG) MS, 25° Optimal Tilt'],
        ['Estimated Annual Gen.', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh (Units) per year`],
      ].map((r,i) => `
        <div style="display:flex;border-bottom:1px solid #C8E6C9;background:${i%2===0?'#F1F8E9':'white'};">
          <div style="padding:12px 20px;width:40%;font-size:12px;font-weight:700;color:#4A6741;">${r[0]}</div>
          <div style="padding:12px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[1]}</div>
        </div>
      `).join('')}
    </div>
  </div>
  <div class="page-footer">Page 6 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 7: FINANCIAL SAVINGS -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Return on Investment</div>
    <div style="font-size:32px;font-weight:900;">Financial Savings Analysis</div>
  </div>
  <div style="padding:32px 48px;">

    <!-- 4 Highlight Boxes -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:28px;">
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;">Total System Cost</div>
        <div style="font-size:20px;font-weight:900;color:#1A2F1A;margin-top:6px;">₹${fin.quotedPrice.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#E8F5E9;border:2px solid #8BC34A;border-radius:12px;padding:16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;right:0;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:3px 8px;border-radius:0 0 0 8px;">APPROVED</div>
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">PM Surya Ghar Subsidy</div>
        <div style="font-size:20px;font-weight:900;color:#2E7D32;margin-top:6px;">₹${fin.subsidyAmount.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#1B5E20;border-radius:12px;padding:16px;transform:scale(1.04);z-index:1;">
        <div style="font-size:10px;font-weight:700;color:#8BC34A;text-transform:uppercase;letter-spacing:1px;">Your Net Investment</div>
        <div style="font-size:24px;font-weight:900;color:white;margin-top:6px;">₹${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#F1F8E9;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">Payback Period</div>
        <div style="font-size:20px;font-weight:900;color:#1B5E20;margin-top:6px;">${fin.payback} Years</div>
      </div>
    </div>

    <div style="display:flex;gap:24px;">
      <!-- Savings Table -->
      <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:16px;overflow:hidden;">
        <div style="background:#E8F5E9;padding:14px 20px;border-bottom:2px solid #C8E6C9;">
          <div style="font-weight:900;color:#1B5E20;font-size:14px;">📈 Savings Projections</div>
        </div>
        ${[
          ['Annual Generation', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh`],
          ['Current Monthly Bill', `₹${fin.monthlyBefore.toLocaleString('en-IN')}`],
          ['Monthly Savings', `₹${Math.round(fin.annualSaving/12).toLocaleString('en-IN')}`],
          ['Annual Savings', `₹${fin.annualSaving.toLocaleString('en-IN')}`],
          ['10 Year Savings', `₹${(fin.annualSaving*10).toLocaleString('en-IN')}`],
          ['25 Year Savings', `₹${(fin.annualSaving*25).toLocaleString('en-IN')}`],
          ['25 Year Net Profit', `₹${fin.saving25yr.toLocaleString('en-IN')}`],
        ].map((r,i) => `
          <div style="display:flex;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #C8E6C9;${i===6?'':''}">
            <span style="font-size:12px;color:#4A6741;font-weight:600;">${r[0]}</span>
            <span style="font-size:12px;font-weight:900;color:${i>=2&&i<=3?'#2E7D32':i===6?'#F9A825':'#1A2F1A'};">${r[1]}</span>
          </div>
        `).join('')}
      </div>

      <!-- Right side -->
      <div style="flex:1;display:flex;flex-direction:column;gap:16px;">
        <!-- Before / After -->
        <div style="display:flex;gap:12px;">
          <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Before Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1A2F1A;">₹${fin.monthlyBefore.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#4A6741;margin-top:4px;">per month</div>
          </div>
          <div style="flex:1;background:#F1F8E9;border:2px solid #8BC34A;border-radius:12px;padding:14px;text-align:center;position:relative;overflow:hidden;">
            <div style="position:absolute;top:-4px;right:-16px;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:4px 24px;transform:rotate(45deg);">SAVE ${fin.savePct}%</div>
            <div style="font-size:10px;color:#2E7D32;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">After Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1B5E20;">₹${fin.monthlyAfter.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#2E7D32;margin-top:4px;">per month</div>
          </div>
        </div>

        <!-- Monthly Chart -->
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;flex:1;">
          <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Monthly Generation (kWh)</div>
          <div style="display:flex;align-items:flex-end;gap:3px;height:90px;border-bottom:2px solid #E8F5E9;padding-bottom:4px;margin-top:12px;">
            ${chartBars}
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="page-footer">Page 7 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 8: BILL OF MATERIALS -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Technical Delivery</div>
    <div style="font-size:32px;font-weight:900;">Bill of Materials (BOM)</div>
  </div>
  <div style="padding:32px 48px;">
    <div style="background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;">
      <table>
        <thead>
          <tr style="background:#1B5E20;color:white;">
            <th style="padding:14px 20px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;width:22%;">Component</th>
            <th style="padding:14px 20px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;width:44%;">Brand & Specification</th>
            <th style="padding:14px 20px;text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;width:10%;">Qty</th>
            <th style="padding:14px 20px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;width:24%;">Warranty</th>
          </tr>
        </thead>
        <tbody>
          ${[
            [panelBrand, `${panelBrand} 550W Mono PERC Half Cut`, `${panelCount} Nos`, '25yr Performance / 10yr Product'],
            ['Inverter', `${inverterBrand} ${fin.systemKw}kW Wi-Fi String Inverter IP65`, '1 No', '10 Years'],
            ['Structure', 'GI/MS Hot Dip Galvanized 25° MNRE Approved', '1 Set', '10 Years'],
            ['DC Cables', '4mm UV Resistant with MC4 Connectors', 'As Req.', '10 Years'],
            ['AC DB Box', 'IP65 Enclosure with SPD, MCB, Isolator', '1 No', '2 Years'],
            ['Earthing & LA', 'Maintenance-free GI Plate & Lightning Arrester', '1 Set', '5 Years'],
            ['Net Meter', 'Bidirectional DISCOM Approved Meter', '1 No', 'Per DISCOM'],
          ].map((r,i) => `
            <tr style="border-bottom:1px solid #C8E6C9;background:${i%2===0?'white':'#F1F8E9'};">
              <td style="padding:14px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
              <td style="padding:14px 20px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
              <td style="padding:14px 20px;font-size:12px;font-weight:900;color:#1B5E20;text-align:center;background:${i%2===0?'#E8F5E9':'#E8F5E9'};">${r[2]}</td>
              <td style="padding:14px 20px;font-size:12px;font-weight:900;color:#2E7D32;">${r[3]}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div style="margin-top:20px;background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;gap:16px;">
      <div style="background:#E8F5E9;padding:10px;border-radius:50%;font-size:20px;flex-shrink:0;height:fit-content;">⚙</div>
      <div>
        <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:6px;">Balance of System (BOS) Inclusion Note:</div>
        <div style="font-size:12px;color:#4A6741;font-weight:600;line-height:1.6;">All necessary civil work for foundation blocks, PVC conduits, junction boxes, cable trays, and minor hardware required for a safe, code-compliant installation are fully included in the system cost.</div>
      </div>
    </div>
  </div>
  <div class="page-footer">Page 8 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 9: PRICING & PAYMENT -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;">
  <div style="background:#1B5E20;padding:40px 48px;color:white;">
    <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">🌱 Commercials</div>
    <div style="font-size:32px;font-weight:900;">Pricing & Payment Terms</div>
  </div>
  <div style="padding:32px 48px;display:flex;flex-direction:column;gap:24px;">

    <!-- Price Breakdown -->
    <div style="background:white;border:4px solid #1B5E20;border-radius:16px;padding:28px;position:relative;margin-top:12px;">
      <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);background:#1B5E20;color:white;padding:6px 20px;border-radius:20px;font-weight:700;font-size:12px;letter-spacing:2px;text-transform:uppercase;white-space:nowrap;">🌿 Final Quotation</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-top:8px;">
        <span style="font-size:17px;font-weight:700;color:#4A6741;">Total System Cost</span>
        <span style="font-size:20px;font-weight:900;color:#1A2F1A;">₹ ${fin.quotedPrice.toLocaleString('en-IN')}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:20px;border-bottom:2px dashed #C8E6C9;color:#2E7D32;">
        <span style="font-size:15px;font-weight:700;">Less: PM Surya Ghar Subsidy</span>
        <span style="font-size:17px;font-weight:900;">- ₹ ${fin.subsidyAmount.toLocaleString('en-IN')}</span>
      </div>
      <div style="background:#F1F8E9;padding:20px 24px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;border:1px solid #C8E6C9;">
        <div>
          <div style="font-size:11px;font-weight:900;color:#1B5E20;text-transform:uppercase;letter-spacing:2px;">Net Amount Payable</div>
          <div style="font-size:10px;color:#4A6741;margin-top:2px;">*Excluding GST as applicable</div>
        </div>
        <div style="font-size:44px;font-weight:900;color:#1B5E20;">₹ ${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
    </div>

    <!-- Payment Milestones -->
    <div>
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:12px;">📄 Payment Milestones</div>
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;overflow:hidden;">
        <table style="width:100%;">
          <thead>
            <tr style="background:#E8F5E9;color:#2E7D32;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">
              <th style="padding:12px 20px;text-align:left;">Milestone</th>
              <th style="padding:12px 20px;text-align:left;">Timeline</th>
              <th style="padding:12px 20px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${[
              ['20% Advance', 'On Proposal Signing (Due Today)', `₹ ${fin.advance.toLocaleString('en-IN')}`],
              ['70% Material Readiness', 'Before Material Delivery (Day 3-5)', `₹ ${fin.material.toLocaleString('en-IN')}`],
              ['10% Commissioning', 'After Meter Install & Testing', `₹ ${fin.final.toLocaleString('en-IN')}`],
            ].map((r,i) => `
              <tr style="border-top:1px solid #C8E6C9;background:${i%2===1?'#F1F8E9':'white'};">
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;text-align:right;">${r[2]}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Bank Details -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#1B5E20;color:white;padding:20px;border-radius:16px;">
        <div style="font-size:11px;font-weight:900;color:#F9A825;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.2);">🛡 Bank Details</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Bank:</span>${installer.bank_name || 'HDFC Bank'}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Account:</span>${installer.account_no || 'XXXX XXXX XXXX'}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">IFSC:</span>${installer.ifsc || 'HDFC0001234'}</div>
        <div style="font-size:12px;font-weight:900;color:#F9A825;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.2);">⚡ UPI: ${installer.upi || 'suryapower@hdfcbank'}</div>
      </div>
      <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:20px;">
        <div style="font-size:14px;font-weight:900;color:#1B5E20;margin-bottom:10px;">✓ Important Note</div>
        <div style="font-size:12px;color:#4A6741;line-height:1.7;">GST at prevailing rates will be charged extra. The PM Surya Ghar subsidy of ₹${fin.subsidyAmount.toLocaleString('en-IN')} will be credited <strong style="color:#1B5E20;">directly to your linked bank account</strong> by the government within 30-60 days post-commissioning. 🌱</div>
      </div>
    </div>
  </div>
  <div class="page-footer">Page 9 of 10 | SolarQuote</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!-- PAGE 10: NEXT STEPS & SIGNATURE -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="page" style="background:#F1F8E9;padding:48px;display:flex;flex-direction:column;">

  <!-- Journey Steps -->
  <div style="margin-bottom:40px;">
    <div style="font-size:28px;font-weight:900;color:#1B5E20;text-align:center;margin-bottom:32px;">🌿 Your Journey to Clean Energy</div>
    <div style="position:relative;display:flex;justify-content:space-between;align-items:flex-start;">
      <div style="position:absolute;top:28px;left:0;width:100%;height:4px;background:#C8E6C9;border-radius:2px;z-index:0;"></div>
      ${[
        {no:1,label:'Sign Proposal'},
        {no:2,label:'20% Advance'},
        {no:3,label:'Site Survey'},
        {no:4,label:'Installation'},
        {no:5,label:'Net Metering'},
        {no:6,label:'Subsidy Credit'},
      ].map(s => `
        <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:56px;height:56px;border-radius:50%;background:#1B5E20;color:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;border:4px solid #F1F8E9;">${s.no}</div>
          <div style="font-size:10px;font-weight:900;color:#2E7D32;text-align:center;width:70px;line-height:1.3;text-transform:uppercase;letter-spacing:0.5px;">${s.label}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Scope -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px;">
    <div style="background:white;padding:24px;border-radius:16px;border:2px solid #C8E6C9;border-top:8px solid #8BC34A;">
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:16px;">✓ Scope Included</div>
      ${['All Solar Materials & Components','End-to-End Installation & Wiring','Custom Mounting Structure','Subsidy Documentation & Portal Entry','Net Meter Application Process','1 Year Free Workmanship Warranty'].map(s => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#8BC34A;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>
      `).join('')}
    </div>
    <div style="background:white;padding:24px;border-radius:16px;border:2px solid #C8E6C9;border-top:8px solid #4A6741;">
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:16px;">⚙ Scope Excluded</div>
      ${['Official DISCOM / Utility Fees','Major Pre-existing Electrical Upgrades','Major Civil Roof Repairs before installation','Water arrangement for panel cleaning'].map(s => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#4A6741;opacity:0.5;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Signatures -->
  <div style="display:flex;justify-content:space-between;padding:0 32px;margin-bottom:32px;">
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${customer.name}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Customer Acceptance & Date</div>
    </div>
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Authorised Signatory — ${today}</div>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#1B5E20;margin:-48px;margin-top:auto;padding:40px 48px;color:white;position:relative;overflow:hidden;">
    <div style="font-size:32px;font-weight:900;text-align:center;margin-bottom:8px;">Thank You for Choosing Clean Energy</div>
    <div style="text-align:center;color:#8BC34A;font-weight:700;font-size:15px;margin-bottom:28px;">🌿 Together we are building a sustainable India.</div>
    <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(139,195,74,0.3);border-bottom:1px solid rgba(139,195,74,0.3);padding:16px 0;margin-bottom:20px;">
      <span>📞 ${installer.phone || '98765 43210'}</span>
      <span>✉ ${installer.email || 'info@suryapower.com'}</span>
      <span>🌐 ${installer.website || 'www.suryapower.com'}</span>
    </div>
    <div style="text-align:center;font-size:10px;color:#C8E6C9;opacity:0.8;text-transform:uppercase;letter-spacing:2px;">
      ${installer.company_name || 'Surya Power Solutions'} • GST: ${installer.gst || 'XXXXXXXXXXXX'} • Powered by SolarQuote
    </div>
  </div>
</div>

</body>
</html>`;

  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.pdf({
    path:              pdfPath,
    format:            'A4',
    printBackground:   true,
    margin:            { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await browser.close();
}

// ── SERVE STATIC ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SolarQuote running on port ${PORT}`);
});
