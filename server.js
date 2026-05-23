import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
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
// Basic Auth upload is used to avoid Cloudinary Invalid Signature errors.
// Keep these 3 Railway variables only:
// CLOUDINARY_CLOUD_NAME
// CLOUDINARY_API_KEY
// CLOUDINARY_API_SECRET

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error('Cloudinary variables missing. Check Railway variables.');
}

console.log('SERVER VERSION: CLOUDINARY BASIC AUTH UPLOAD ACTIVE');
console.log('Cloudinary cloud_name:', CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING');
console.log('Cloudinary api_key:', CLOUDINARY_API_KEY ? 'SET' : 'MISSING');
console.log('Cloudinary api_secret:', CLOUDINARY_API_SECRET ? 'SET' : 'MISSING');
console.log('Cloudinary cloud_name length:', CLOUDINARY_CLOUD_NAME.length);
console.log('Cloudinary api_key length:', CLOUDINARY_API_KEY.length);
console.log('Cloudinary api_secret length:', CLOUDINARY_API_SECRET.length);

// ── OPENAI ────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── TEMP DIR ──────────────────────────────────────────────────────────────────
const TMP = '/tmp/solarscan';
fs.mkdirSync(TMP, { recursive: true });

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getPanelLayout(count) {
  if (count <= 12) return { rows: 2, cols: Math.ceil(count / 2) };
  if (count <= 21) return { rows: 3, cols: Math.ceil(count / 3) };
  return { rows: 4, cols: Math.ceil(count / 4) };
}

function buildPrompt(systemKw, panelCount, legHeightsFt, roofType) {
  const layout = getPanelLayout(panelCount);

  const avgLeg = legHeightsFt.length
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
function optimizeCloudinaryImage(url, width = 1000) {
  if (!url || !url.includes('/upload/')) return url;

  return url.replace(
    '/upload/',
    `/upload/f_jpg,q_auto:eco,w_${width}/`
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
  const savePct      = monthlyBill > 0 ? Math.round(((monthlyBill - monthlyAfter) / monthlyBill) * 100) : 0;
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

// ── CLOUDINARY UPLOAD USING BASIC AUTH ────────────────────────────────────────
// This avoids signature generation completely.

async function uploadToCloudinary(buffer, folder, publicId, resourceType = 'image') {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

  const formData = new FormData();

  const fileName = resourceType === 'raw' ? `${publicId}.pdf` : `${publicId}.jpg`;
  const fileType = resourceType === 'raw' ? 'application/pdf' : 'image/jpeg';

  formData.append(
    'file',
    new Blob([buffer], { type: fileType }),
    fileName
  );

  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('overwrite', 'true');

  const authHeader = Buffer
    .from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`)
    .toString('base64');

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
    },
    body: formData,
  });

  const responseText = await response.text();

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Cloudinary returned non-JSON response: ${responseText.slice(0, 300)}`);
  }

  console.log('Cloudinary Basic Auth response:', JSON.stringify(data).slice(0, 300));

  if (!response.ok || data.error) {
    throw new Error('Cloudinary: ' + (data.error?.message || responseText));
  }

  if (!data.secure_url) {
    throw new Error('Cloudinary: Upload succeeded but secure_url missing');
  }

  return data.secure_url;
}
// ── INSTALLER PROFILE SAVE ────────────────────────────────────────────────────
app.post('/api/save-profile', upload.fields([
  { name: 'logo',     maxCount: 1 },
  { name: 'project0', maxCount: 1 },
  { name: 'project1', maxCount: 1 },
  { name: 'project2', maxCount: 1 },
  { name: 'project3', maxCount: 1 },
  { name: 'project4', maxCount: 1 },
  { name: 'project5', maxCount: 1 },
]), async (req, res) => {
  try {
    const installerId = req.body.installer_id || 'default';
    const profile     = JSON.parse(req.body.profile_json || '{}');

    if (req.files?.logo?.[0]) {
      profile.logo_url = await uploadToCloudinary(
        req.files.logo[0].buffer,
        `solarscan/${installerId}`,
        'logo'
      );
    }

    profile.projects = profile.projects || [];

    for (let i = 0; i < 6; i++) {
      const key  = `project${i}`;
      const meta = profile.projects[i] || {};

      if (req.files?.[key]?.[0]) {
        meta.photo_url = await uploadToCloudinary(
          req.files[key][0].buffer,
          `solarscan/${installerId}/projects`,
          `project_${i}`
        );
      }

      profile.projects[i] = meta;
    }

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── INSTALLER PROFILE LOAD ────────────────────────────────────────────────────
app.get('/api/load-profile', (req, res) => {
  try {
    const installerId  = req.query.installer_id || 'default';
    const profilePath  = path.join(TMP, `profile_${installerId}.json`);

    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      res.json({ success: true, profile });
    } else {
      res.json({ success: true, profile: null });
    }
  } catch (err) {
    console.error('Load profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── MAIN QUOTE GENERATION ─────────────────────────────────────────────────────
app.post('/api/generate-quote', upload.single('photo'), async (req, res) => {
  const jobId  = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    if (!req.file?.buffer) {
      throw new Error('No roof photo uploaded');
    }

    const systemKw      = parseFloat(req.body.system_kw || 5);
    const panelWatt     = parseInt(req.body.panel_watt || 550);
    const panelCount    = Math.ceil((systemKw * 1000) / panelWatt);
    const quotedPrice   = parseInt(req.body.quoted_price || 325000);
    const subsidyAmount = parseInt(req.body.subsidy_amount || 78000);
    const monthlyBill   = parseInt(req.body.monthly_bill || 3000);
    const roofType      = req.body.roof_type || 'flat_rcc';
    const panelBrand    = req.body.panel_brand || 'Waaree Solar';
    const inverterBrand = req.body.inverter_brand || 'Solis';
    const legHeights    = JSON.parse(req.body.leg_heights_ft || '[3]');
    const installerId   = req.body.installer_id || 'default';

    const customer = {
      name:    req.body.customer_name || 'Homeowner',
      phone:   req.body.customer_phone || '',
      address: req.body.customer_address || '',
    };

    const profilePath = path.join(TMP, `profile_${installerId}.json`);

    const installer = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8'))
      : {
          company_name: req.body.installer_name || 'Solar Installer',
          phone:        req.body.installer_phone || '',
          email:        req.body.installer_email || '',
          website:      '',
          address:      '',
          gst:          '',
          years:        '5+',
          total_kw:     '500+',
          bank_name:    '',
          account_no:   '',
          ifsc:         '',
          upi:          '',
          logo_url:     '',
          projects:     [],
        };

    const photoPath = path.join(jobDir, 'roof_marked.jpg');
    fs.writeFileSync(photoPath, req.file.buffer);

    console.log(`Photo size: ${req.file.buffer.length} bytes, mimetype: ${req.file.mimetype}`);
    console.log(`Job ${jobId}: Generating AI image...`);

    const prompt = buildPrompt(systemKw, panelCount, legHeights, roofType);

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

    const imageBuffer = Buffer.from(aiResult.data[0].b64_json, 'base64');
    const resultPath  = path.join(jobDir, 'result.jpg');
    fs.writeFileSync(resultPath, imageBuffer);

    console.log(`Job ${jobId}: Uploading AI image to Cloudinary...`);

    const aiImageUrl = await uploadToCloudinary(
      imageBuffer,
      'solarscan/results',
      `result_${jobId}`,
      'image'
    );

    const fin = calcFinancials(systemKw, monthlyBill, quotedPrice, subsidyAmount);

    console.log(`Job ${jobId}: Generating PDF...`);

    const pdfPath = path.join(jobDir, 'proposal.pdf');

    await generatePDF({
      installer,
      customer,
      fin,
      panelBrand,
      inverterBrand,
      panelCount,
      aiImageUrl,
      jobId,
      pdfPath,
    });

    console.log(`Job ${jobId}: Uploading PDF to Cloudinary...`);
     const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfUrl = await uploadToCloudinary(
      pdfBuffer,
      'solarscan/pdfs',
      `proposal_${jobId}`,
      'raw'
    );

    res.json({
      success:    true,
      job_id:     jobId,
      image_url:  aiImageUrl,
      pdf_url:    pdfUrl,
      financials: fin,
    });

  } catch (err) {
    console.error('Generate quote error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    setTimeout(() => {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }, 600000);
  }
});

// ── PDF GENERATION ────────────────────────────────────────────────────────────
async function generatePDF({
  installer,
  customer,
  fin,
  panelBrand,
  inverterBrand,
  panelCount,
  aiImageUrl,
  jobId,
  pdfPath,
}) {
  const today = new Date().toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
  });

  const validDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-IN', {
      day:   '2-digit',
      month: 'short',
      year:  'numeric',
    });

  const proposalNo = `SP-${new Date().getFullYear()}-${jobId.toUpperCase()}`;

  const projects = installer.projects || [];

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
              <div style="font-size:22px;font-weight:900;">${p.name || 'Project ' + (idx + 1)}</div>
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
      </div>
    `;
  };

  const proj0 = projectCards(projects[0], 0);
  const proj1 = projectCards(projects[1], 1);
  const proj2 = projectCards(projects[2], 2);
  const proj3 = projectCards(projects[3], 3);
  const proj4 = projectCards(projects[4], 4);
  const proj5 = projectCards(projects[5], 5);

  const monthlyData = [
    { m: 'Jan', v: 450 },
    { m: 'Feb', v: 520 },
    { m: 'Mar', v: 650 },
    { m: 'Apr', v: 720 },
    { m: 'May', v: 750 },
    { m: 'Jun', v: 750 },
    { m: 'Jul', v: 600 },
    { m: 'Aug', v: 550 },
    { m: 'Sep', v: 580 },
    { m: 'Oct', v: 620 },
    { m: 'Nov', v: 500 },
    { m: 'Dec', v: 450 },
  ];

  const maxV = 750;

  const chartBars = monthlyData.map(d => `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;">
      <div style="width:100%;max-width:18px;height:${Math.round((d.v / maxV) * 80)}px;background:linear-gradient(to top,#8BC34A,#1B5E20);border-radius:2px 2px 0 0;"></div>
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

<!-- PAGE 0: INTRO -->
<div class="page" style="background:#1A2F1A;">
  <div style="position:absolute;inset:0;opacity:0.08;background-image:radial-gradient(#fff 1.5px,transparent 1.5px);background-size:16px 16px;pointer-events:none;"></div>

  <div style="position:relative;height:48%;width:100%;">
    <div style="position:absolute;top:0;left:0;width:45%;height:96px;background:#F9A825;clip-path:polygon(0 0,100% 0,0 100%);z-index:2;"></div>

    <div style="position:absolute;top:0;right:0;width:45%;height:128px;background:#2E7D32;clip-path:polygon(20% 0,100% 0,100% 100%,0 100%);z-index:2;display:flex;align-items:flex-start;justify-content:flex-end;padding:28px;">
      <div style="text-align:right;color:white;display:flex;align-items:center;gap:12px;">
        <div>
          <div style="font-weight:900;font-size:18px;line-height:1;">SURYA</div>
          <div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;opacity:0.9;">Company</div>
        </div>
        <div style="width:40px;height:40px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;">🌿</div>
      </div>
    </div>

    <div style="position:absolute;top:80px;right:0;width:96px;height:100%;background:#F9A825;clip-path:polygon(100% 0,100% 100%,0 40%);z-index:0;"></div>

    <div style="position:absolute;inset:0;z-index:1;background:#1B5E20;border-radius:0 0 96px 0;overflow:hidden;">
      <img src="https://images.unsplash.com/photo-1509391366360-2e959784a276?auto=format&fit=crop&w=1200&q=80"
           style="width:100%;height:100%;object-fit:cover;object-position:bottom;" />
      <div style="position:absolute;inset:0;background:rgba(27,94,32,0.2);"></div>
    </div>
  </div>

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
          <div style="width:24px;height:24px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;">🌐</div>
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

<!-- PAGE 1: COVER -->
<div class="page" style="background:#F1F8E9;">
  <div style="position:absolute;top:0;left:0;width:100%;height:55%;background:#1B5E20;border-radius:0 0 96px 96px;z-index:0;"></div>

  <div style="padding:48px;display:flex;flex-direction:column;height:100%;position:relative;z-index:1;">
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

    <div style="margin-bottom:24px;">
      <div style="color:#F9A825;font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:13px;margin-bottom:12px;">🌿 India's Trusted Rooftop Solar EPC</div>
      <div style="font-size:52px;font-weight:900;color:white;line-height:1.1;">CLEAN ENERGY<br/>PROPOSAL</div>
    </div>

    <div style="flex:1;width:100%;border:4px solid #8BC34A;border-radius:24px;overflow:hidden;position:relative;min-height:200px;">
      <img src="${aiImageUrl}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.3),transparent);"></div>
    </div>

    <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;">
      <div style="background:white;padding:22px 28px;border-radius:20px;flex:1;box-shadow:0 10px 30px rgba(0,0,0,0.12);">
        <div style="font-size:12px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Prepared For</div>
        <div style="font-size:26px;font-weight:900;color:#1B5E20;">${customer.name || 'Homeowner'}</div>
        <div style="font-size:13px;color:#4A6741;margin-top:6px;">${customer.address || 'Customer Address'}</div>
      </div>

      <div style="background:#F9A825;color:#1A2F1A;padding:22px 28px;border-radius:20px;text-align:center;min-width:180px;box-shadow:0 10px 30px rgba(0,0,0,0.12);">
        <div style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">System Size</div>
        <div style="font-size:40px;font-weight:900;line-height:1;margin-top:6px;">${fin.systemKw} kW</div>
        <div style="font-size:12px;font-weight:700;margin-top:6px;">${panelCount} Panels</div>
      </div>
    </div>
  </div>

  <div class="page-footer">Solar Proposal | ${installer.company_name || 'Solar Installer'}</div>
</div>

<!-- PAGE 2: PROJECT SUMMARY -->
<div class="page" style="background:white;">
  <div style="height:120px;background:#1B5E20;border-radius:0 0 48px 48px;padding:36px 48px;color:white;">
    <div style="font-size:32px;font-weight:900;">Project Summary</div>
    <div style="font-size:13px;color:#C8E6C9;margin-top:6px;">Complete rooftop solar solution with subsidy and net metering support</div>
  </div>

  <div style="padding:36px 48px;flex:1;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:28px;">
      ${[
        ['System Capacity', `${fin.systemKw} kW`, '#1B5E20'],
        ['Solar Panels', `${panelCount} Nos`, '#2E7D32'],
        ['Panel Brand', panelBrand, '#33691E'],
        ['Inverter Brand', inverterBrand, '#558B2F'],
        ['Annual Generation', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh`, '#689F38'],
        ['Payback Period', `${fin.payback} Years`, '#827717'],
      ].map(([label, value, color]) => `
        <div style="background:#F1F8E9;border-left:6px solid ${color};border-radius:14px;padding:18px;">
          <div style="font-size:11px;color:#4A6741;font-weight:800;text-transform:uppercase;letter-spacing:1px;">${label}</div>
          <div style="font-size:24px;color:#1B5E20;font-weight:900;margin-top:8px;">${value}</div>
        </div>
      `).join('')}
    </div>

    <div style="background:#1B5E20;border-radius:24px;padding:28px;color:white;margin-bottom:24px;">
      <div style="font-size:24px;font-weight:900;margin-bottom:18px;">Financial Snapshot</div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
        <div style="background:rgba(255,255,255,0.12);border-radius:16px;padding:18px;text-align:center;">
          <div style="font-size:12px;color:#C8E6C9;font-weight:700;">Quoted Price</div>
          <div style="font-size:26px;font-weight:900;margin-top:6px;">₹${fin.quotedPrice.toLocaleString('en-IN')}</div>
        </div>

        <div style="background:rgba(255,255,255,0.12);border-radius:16px;padding:18px;text-align:center;">
          <div style="font-size:12px;color:#C8E6C9;font-weight:700;">Govt Subsidy</div>
          <div style="font-size:26px;font-weight:900;margin-top:6px;color:#F9A825;">₹${fin.subsidyAmount.toLocaleString('en-IN')}</div>
        </div>

        <div style="background:#F9A825;border-radius:16px;padding:18px;text-align:center;color:#1A2F1A;">
          <div style="font-size:12px;font-weight:900;">Net Customer Cost</div>
          <div style="font-size:26px;font-weight:900;margin-top:6px;">₹${fin.netCost.toLocaleString('en-IN')}</div>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
      <div style="background:#F9FBE7;border-radius:20px;padding:24px;border:2px solid #E6EE9C;">
        <div style="font-size:20px;font-weight:900;color:#1B5E20;margin-bottom:14px;">Savings Estimate</div>
        <div style="font-size:14px;color:#4A6741;line-height:1.8;">
          Monthly bill before solar: <b>₹${fin.monthlyBefore.toLocaleString('en-IN')}</b><br/>
          Estimated bill after solar: <b>₹${fin.monthlyAfter.toLocaleString('en-IN')}</b><br/>
          Annual savings: <b>₹${fin.annualSaving.toLocaleString('en-IN')}</b><br/>
          25-year savings: <b>₹${fin.saving25yr.toLocaleString('en-IN')}</b>
        </div>
      </div>

      <div style="background:#E8F5E9;border-radius:20px;padding:24px;border:2px solid #A5D6A7;">
        <div style="font-size:20px;font-weight:900;color:#1B5E20;margin-bottom:14px;">Environmental Impact</div>
        <div style="font-size:14px;color:#4A6741;line-height:1.8;">
          CO₂ reduction/year: <b>${fin.co2} tons</b><br/>
          Equivalent trees planted: <b>${fin.trees}</b><br/>
          Clean generation/year: <b>${fin.yearlyKwh.toLocaleString('en-IN')} kWh</b><br/>
          Renewable energy contribution: <b>${fin.savePct}%</b>
        </div>
      </div>
    </div>
  </div>

  <div class="page-footer">Project Summary</div>
</div>

<!-- PAGE 3: ROOF PREVIEW -->
<div class="page" style="background:#F1F8E9;">
  <div style="padding:48px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;">
      <div>
        <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">AI Generated Preview</div>
        <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;">Your Roof With Solar</div>
      </div>

      <div style="background:#F9A825;border-radius:16px;padding:16px 22px;text-align:center;color:#1A2F1A;">
        <div style="font-size:11px;font-weight:900;">PROPOSED</div>
        <div style="font-size:24px;font-weight:900;">${fin.systemKw} kW</div>
      </div>
    </div>

    <div style="background:white;border-radius:28px;padding:18px;box-shadow:0 16px 40px rgba(0,0,0,0.12);">
      <img src="${aiImageUrl}" style="width:100%;height:520px;object-fit:cover;border-radius:20px;" />
    </div>

    <div style="margin-top:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">
      <div style="background:white;border-radius:18px;padding:20px;text-align:center;border:1px solid #C8E6C9;">
        <div style="font-size:28px;">☀️</div>
        <div style="font-size:13px;color:#4A6741;font-weight:800;margin-top:8px;">South Facing</div>
      </div>

      <div style="background:white;border-radius:18px;padding:20px;text-align:center;border:1px solid #C8E6C9;">
        <div style="font-size:28px;">🏗️</div>
        <div style="font-size:13px;color:#4A6741;font-weight:800;margin-top:8px;">Raised Structure</div>
      </div>

      <div style="background:white;border-radius:18px;padding:20px;text-align:center;border:1px solid #C8E6C9;">
        <div style="font-size:28px;">🔩</div>
        <div style="font-size:13px;color:#4A6741;font-weight:800;margin-top:8px;">GI/MS Mounting</div>
      </div>
    </div>
  </div>

  <div class="page-footer">AI Solar Preview</div>
</div>

<!-- PAGE 4: ENERGY CHART -->
<div class="page" style="background:white;">
  <div style="padding:48px;">
    <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">Generation Forecast</div>
    <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;margin-bottom:28px;">Monthly Energy Production</div>

    <div style="background:#F1F8E9;border-radius:28px;padding:32px;margin-bottom:28px;border:2px solid #C8E6C9;">
      <div style="height:160px;display:flex;align-items:flex-end;gap:10px;margin-bottom:16px;">
        ${chartBars}
      </div>

      <div style="font-size:13px;color:#4A6741;line-height:1.7;">
        Your proposed <b>${fin.systemKw} kW</b> system is expected to generate approximately
        <b>${fin.yearlyKwh.toLocaleString('en-IN')} kWh/year</b>, depending on weather, shadow, panel cleaning, and grid availability.
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;">
      <div style="background:#1B5E20;border-radius:24px;padding:28px;color:white;">
        <div style="font-size:18px;font-weight:900;margin-bottom:14px;">Why This System Size?</div>
        <div style="font-size:13px;color:#C8E6C9;line-height:1.8;">
          The proposed capacity is selected based on your monthly bill, rooftop suitability, subsidy eligibility, and expected generation.
          This creates an optimal balance between investment, savings, and payback.
        </div>
      </div>

      <div style="background:#F9A825;border-radius:24px;padding:28px;color:#1A2F1A;">
        <div style="font-size:18px;font-weight:900;margin-bottom:14px;">Estimated Payback</div>
        <div style="font-size:48px;font-weight:900;line-height:1;">${fin.payback}</div>
        <div style="font-size:14px;font-weight:800;margin-top:4px;">Years</div>
        <div style="font-size:12px;line-height:1.6;margin-top:12px;">After payback, most of your solar generation becomes direct savings.</div>
      </div>
    </div>
  </div>

  <div class="page-footer">Energy Forecast</div>
</div>

<!-- PAGE 5: PAYMENT TERMS -->
<div class="page" style="background:#F1F8E9;">
  <div style="padding:48px;">
    <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">Commercial Offer</div>
    <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;margin-bottom:28px;">Payment Schedule</div>

    <div style="background:white;border-radius:28px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,0.10);">
      ${[
        ['1', 'Advance Payment', 'On order confirmation', fin.advance],
        ['2', 'Material Dispatch', 'Before material delivery at site', fin.material],
        ['3', 'Final Payment', 'After installation and commissioning', fin.final],
      ].map(([num, title, desc, amount]) => `
        <div style="display:grid;grid-template-columns:80px 1fr 180px;border-bottom:1px solid #E0E0E0;align-items:center;">
          <div style="background:#1B5E20;color:white;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;">${num}</div>
          <div style="padding:24px;">
            <div style="font-size:20px;font-weight:900;color:#1B5E20;">${title}</div>
            <div style="font-size:13px;color:#4A6741;margin-top:4px;">${desc}</div>
          </div>
          <div style="padding:24px;text-align:right;font-size:22px;font-weight:900;color:#1B5E20;">₹${amount.toLocaleString('en-IN')}</div>
        </div>
      `).join('')}
    </div>

    <div style="margin-top:28px;background:#1B5E20;color:white;border-radius:24px;padding:28px;">
      <div style="font-size:22px;font-weight:900;margin-bottom:18px;">Bank / Payment Details</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;font-size:14px;color:#C8E6C9;line-height:1.8;">
        <div>
          Bank Name: <b style="color:white;">${installer.bank_name || 'To be shared'}</b><br/>
          Account No: <b style="color:white;">${installer.account_no || 'To be shared'}</b>
        </div>
        <div>
          IFSC: <b style="color:white;">${installer.ifsc || 'To be shared'}</b><br/>
          UPI: <b style="color:white;">${installer.upi || 'To be shared'}</b>
        </div>
      </div>
    </div>

    <div style="margin-top:24px;background:#FFFDE7;border:2px solid #FBC02D;border-radius:18px;padding:20px;color:#5D4037;font-size:13px;line-height:1.7;">
      <b>Note:</b> Final subsidy approval, DISCOM processing, net metering timelines, and government scheme benefits are subject to applicable state and central guidelines.
    </div>
  </div>

  <div class="page-footer">Payment Terms</div>
</div>

<!-- PAGE 6: TRUST -->
<div class="page" style="background:white;">
  <div style="height:110px;background:#1B5E20;border-radius:0 0 48px 48px;padding:34px 48px;color:white;">
    <div style="font-size:34px;font-weight:900;">Why Choose ${installer.company_name || 'Us'}?</div>
  </div>

  <div style="padding:42px 48px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:30px;">
      ${[
        ['🏆', `${installer.years || '5+'}`, 'Years Experience'],
        ['⚡', `${installer.total_kw || '500+'}`, 'kW Installed'],
        ['🛡️', '25 Years', 'Panel Warranty'],
        ['✅', 'End-to-End', 'Subsidy Support'],
      ].map(([icon, value, label]) => `
        <div style="background:#F1F8E9;border-radius:24px;padding:28px;text-align:center;border:2px solid #C8E6C9;">
          <div style="font-size:36px;">${icon}</div>
          <div style="font-size:32px;font-weight:900;color:#1B5E20;margin-top:10px;">${value}</div>
          <div style="font-size:13px;font-weight:800;color:#4A6741;margin-top:6px;">${label}</div>
        </div>
      `).join('')}
    </div>

    <div style="background:#1B5E20;border-radius:28px;padding:32px;color:white;">
      <div style="font-size:24px;font-weight:900;margin-bottom:18px;">Our Scope Includes</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        ${[
          'Site survey and engineering design',
          'Solar panel and inverter supply',
          'GI/MS mounting structure',
          'DC/AC cabling and protection',
          'Installation and commissioning',
          'Net metering and subsidy support',
          'Warranty documentation',
          'Post-installation service support',
        ].map(item => `
          <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:#C8E6C9;">
            <div style="width:20px;height:20px;background:#8BC34A;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:10px;flex-shrink:0;">✓</div>
            <span>${item}</span>
          </div>
        `).join('')}
      </div>
    </div>
  </div>

  <div class="page-footer">Trust & Scope</div>
</div>

<!-- PAGE 7: PROJECTS 1 -->
<div class="page" style="background:#F1F8E9;">
  <div style="padding:48px;">
    <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">Past Installations</div>
    <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;margin-bottom:28px;">Our Recent Projects</div>

    <div style="display:flex;gap:22px;height:650px;">
      ${proj0 || projectCards(null, 0)}
      ${proj1 || projectCards(null, 1)}
    </div>
  </div>

  <div class="page-footer">Past Projects</div>
</div>

<!-- PAGE 8: PROJECTS 2 -->
<div class="page" style="background:white;">
  <div style="padding:48px;">
    <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">More References</div>
    <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;margin-bottom:28px;">Customer Success Stories</div>

    <div style="display:flex;gap:22px;height:650px;">
      ${proj2 || projectCards(null, 2)}
      ${proj3 || projectCards(null, 3)}
    </div>
  </div>

  <div class="page-footer">Customer Success</div>
</div>

<!-- PAGE 9: PROJECTS 3 -->
<div class="page" style="background:#F1F8E9;">
  <div style="padding:48px;">
    <div style="font-size:12px;color:#2E7D32;font-weight:900;letter-spacing:2px;text-transform:uppercase;">Installation Proof</div>
    <div style="font-size:38px;font-weight:900;color:#1B5E20;margin-top:6px;margin-bottom:28px;">Completed Solar Sites</div>

    <div style="display:flex;gap:22px;height:650px;">
      ${proj4 || projectCards(null, 4)}
      ${proj5 || projectCards(null, 5)}
    </div>
  </div>

  <div class="page-footer">Installation Proof</div>
</div>

<!-- PAGE 10: NEXT STEPS -->
<div class="page" style="background:#1A2F1A;">
  <div style="position:absolute;inset:0;opacity:0.08;background-image:radial-gradient(#fff 1.5px,transparent 1.5px);background-size:16px 16px;"></div>

  <div style="padding:60px 48px;position:relative;z-index:1;color:white;display:flex;flex-direction:column;height:100%;">
    <div style="font-size:12px;color:#F9A825;font-weight:900;letter-spacing:3px;text-transform:uppercase;">Next Steps</div>
    <div style="font-size:54px;font-weight:900;line-height:1.05;margin-top:14px;">Start Your<br/>Solar Journey</div>

    <div style="margin-top:40px;display:grid;gap:18px;">
      ${[
        ['1', 'Confirm proposal and payment terms'],
        ['2', 'Detailed site verification and final engineering'],
        ['3', 'Material procurement and installation scheduling'],
        ['4', 'Installation, commissioning, net metering and subsidy support'],
      ].map(([num, text]) => `
        <div style="display:flex;align-items:center;gap:18px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.18);border-radius:18px;padding:18px;">
          <div style="width:42px;height:42px;background:#F9A825;color:#1A2F1A;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;flex-shrink:0;">${num}</div>
          <div style="font-size:16px;font-weight:700;color:#E8F5E9;">${text}</div>
        </div>
      `).join('')}
    </div>

    <div style="margin-top:auto;background:#F9A825;color:#1A2F1A;border-radius:28px;padding:32px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:2px;">Contact</div>
        <div style="font-size:28px;font-weight:900;margin-top:8px;">${installer.company_name || 'Solar Installer'}</div>
        <div style="font-size:14px;font-weight:700;margin-top:8px;">${installer.phone || '+91 98765 43210'} | ${installer.email || 'info@solar.com'}</div>
      </div>

      <div style="font-size:52px;">☀️</div>
    </div>
  </div>
</div>

</body>
</html>`;

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

  await page.setContent(html, {
    waitUntil: 'networkidle0',
    timeout: 60000,
  });

  await page.pdf({
    path:            pdfPath,
    format:          'A4',
    printBackground: true,
    margin:          {
      top:    0,
      right:  0,
      bottom: 0,
      left:   0,
    },
  });

  await browser.close();
}

// ── SERVE STATIC ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`solarscan running on port ${PORT}`);
});
