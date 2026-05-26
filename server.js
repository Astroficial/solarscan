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

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'static')));

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY    = (process.env.CLOUDINARY_API_KEY    || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error('Cloudinary variables missing. Check Railway variables.');
}

console.log('Cloudinary cloud_name:', CLOUDINARY_CLOUD_NAME);
console.log('Cloudinary api_key length:', CLOUDINARY_API_KEY.length);
console.log('Cloudinary api_secret length:', CLOUDINARY_API_SECRET.length);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    `Install a ${systemKw} kW rooftop solar system using exactly ${panelCount} separate solar panels arranged in ${layout.rows} rows x ${layout.cols} columns. ` +
    `Every panel must be clearly separate and countable with its own visible aluminum frame, clear gap from adjacent panels, and realistic blue photovoltaic cell texture. Do not merge panels into one large sheet. ` +
    `Mount the panels on realistic elevated Indian rooftop GI/MS support structure with visible rails, braces, clamps, cross members, and RCC concrete pedestal blocks. ` +
    `If red support guide lines are visible, use them as guidance for extended support rods. Extend realistic GI/MS support rods from the solar panel frame down to the marked roof footing points. Place RCC concrete blocks at the base. ` +
    `The average support leg height required is approximately ${avgLeg} feet. This is a raised structure at 25-30 degree tilt angle. ` +
    `The camera was pointing NORTH. Therefore all solar panels must face TRUE SOUTH directly toward the camera. The full front glass surface of all panels must be visible. ` +
    `Preserve the original roof photo completely. Do not change roof geometry, parapet walls, vents, tanks, AC units, pipes, trees, towers, buildings, sky, or background. ` +
    `Add realistic shadows under panels, support rods, frames, and RCC blocks matching the original sunlight direction. ` +
    `Strict negative instructions: do not create one continuous solar sheet. Do not merge panels. Do not change panel count. Do not create floating panels. Do not distort roof or background.`
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
    systemKw, quotedPrice, subsidyAmount, netCost,
    yearlyKwh, annualSaving, payback, saving25yr,
    monthlyBefore: monthlyBill, monthlyAfter, savePct,
    co2, trees,
    advance:  Math.round(netCost * 0.20),
    material: Math.round(netCost * 0.70),
    final:    Math.round(netCost * 0.10),
  };
}

// ── CLOUDINARY UPLOAD ─────────────────────────────────────────────────────────

async function uploadToCloudinary(buffer, folder, publicId, resourceType = 'image') {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
  const isProfile = publicId.includes('profile');
  const fileName  = resourceType === 'raw'
    ? (isProfile ? `${publicId}.json` : `${publicId}.pdf`)
    : `${publicId}.jpg`;
  const fileType  = resourceType === 'raw'
    ? (isProfile ? 'application/json' : 'application/pdf')
    : 'image/jpeg';

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: fileType }), fileName);
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('overwrite', 'true');

  const authHeader = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${authHeader}` },
    body: formData,
  });

  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { throw new Error(`Cloudinary non-JSON: ${responseText.slice(0, 200)}`); }

  if (!response.ok || data.error) throw new Error('Cloudinary: ' + (data.error?.message || responseText));
  if (!data.secure_url) throw new Error('Cloudinary: secure_url missing');
  console.log(`Cloudinary upload OK: ${data.public_id}`);
  return data.secure_url;
}

// ── SAVE PROFILE ──────────────────────────────────────────────────────────────

app.post('/api/save-profile', upload.fields([
  { name: 'logo',     maxCount: 1 },
  { name: 'project0', maxCount: 1 }, { name: 'project1', maxCount: 1 },
  { name: 'project2', maxCount: 1 }, { name: 'project3', maxCount: 1 },
  { name: 'project4', maxCount: 1 }, { name: 'project5', maxCount: 1 },
]), async (req, res) => {
  try {
    const installerId = req.body.installer_id || 'default';
    const profile     = JSON.parse(req.body.profile_json || '{}');

    if (req.files?.logo?.[0]) {
      profile.logo_url = await uploadToCloudinary(
        req.files.logo[0].buffer, `solarscan/${installerId}`, 'logo'
      );
    }

    profile.projects = profile.projects || [];
    for (let i = 0; i < 6; i++) {
      const key  = `project${i}`;
      const meta = profile.projects[i] || {};
      if (req.files?.[key]?.[0]) {
        const buf = req.files[key][0].buffer;
        meta.photo_url = await uploadToCloudinary(buf, `solarscan/${installerId}/projects`, `project_${i}`);
        const localPath = path.join(TMP, `${installerId}_project_${i}.jpg`);
        fs.writeFileSync(localPath, buf);
        meta.local_path = localPath;
      }
      profile.projects[i] = meta;
    }

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const profileBuf = Buffer.from(JSON.stringify(profile, null, 2));
    await uploadToCloudinary(profileBuf, `solarscan/${installerId}`, 'profile', 'raw');

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LOAD PROFILE ──────────────────────────────────────────────────────────────

app.get('/api/load-profile', async (req, res) => {
  try {
    const installerId = req.query.installer_id || 'default';
    const profilePath = path.join(TMP, `profile_${installerId}.json`);

    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      return res.json({ success: true, profile });
    }

    console.log('Profile not in /tmp, fetching from Cloudinary...');
    const url = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/raw/upload/solarscan/${installerId}/profile`;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const profile = await r.json();
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
        console.log('Profile restored from Cloudinary');
        return res.json({ success: true, profile });
      }
      console.log('Cloudinary profile fetch status:', r.status);
    } catch (e) {
      console.log('Cloudinary profile fetch error:', e.message);
    }

    res.json({ success: true, profile: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE QUOTE ────────────────────────────────────────────────────────────

app.post('/api/generate-quote', upload.single('photo'), async (req, res) => {
  const jobId  = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    if (!req.file?.buffer) throw new Error('No roof photo uploaded');

    const systemKw      = parseFloat(req.body.system_kw      || 5);
    const panelWatt     = parseInt(req.body.panel_watt        || 550);
    const panelCount    = Math.ceil((systemKw * 1000) / panelWatt);
    const quotedPrice   = parseInt(req.body.quoted_price      || 325000);
    const subsidyAmount = parseInt(req.body.subsidy_amount    || 78000);
    const monthlyBill   = parseInt(req.body.monthly_bill      || 3000);
    const roofType      = req.body.roof_type                  || 'flat_rcc';
    const panelBrand    = req.body.panel_brand                || 'Waaree Solar';
    const inverterBrand = req.body.inverter_brand             || 'Solis';
    const installerId   = req.body.installer_id               || 'default';

    let legHeights = [3];
    try {
      legHeights = JSON.parse(req.body.leg_heights_ft || '[3]');
      if (!Array.isArray(legHeights)) legHeights = [3];
    } catch(e) { legHeights = [3]; }

    const customer = {
      name:    req.body.customer_name    || 'Homeowner',
      phone:   req.body.customer_phone   || '',
      address: req.body.customer_address || '',
    };

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    let installer;

    if (fs.existsSync(profilePath)) {
      installer = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      console.log(`Profile loaded from /tmp. Projects: ${installer.projects?.length || 0}`);
      console.log(`Project 0 name: ${installer.projects?.[0]?.name || 'EMPTY'}`);
      console.log(`Project 0 photo_url: ${installer.projects?.[0]?.photo_url || 'NONE'}`);
      console.log(`Project 0 local_path: ${installer.projects?.[0]?.local_path || 'NONE'}`);
    } else {
      console.log('Profile not in /tmp, fetching from Cloudinary...');
      const url = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/raw/upload/solarscan/${installerId}/profile`;
      try {
        const r = await fetch(url);
        if (r.ok) {
          installer = await r.json();
          fs.writeFileSync(profilePath, JSON.stringify(installer, null, 2));
          console.log(`Profile restored. Projects: ${installer.projects?.length || 0}`);
        } else {
          console.log('Cloudinary profile fetch status:', r.status);
          installer = null;
        }
      } catch(e) {
        console.log('Cloudinary fetch error:', e.message);
        installer = null;
      }
      if (!installer) {
        installer = {
          company_name: 'Solar Installer', phone: '', email: '',
          website: '', address: '', gst: '', years: '5+',
          total_kw: '500+', bank_name: '', account_no: '',
          ifsc: '', upi: '', logo_url: '', projects: [],
        };
      }
    }

    // Restore local photo files if missing after redeploy
    if (installer.projects) {
      for (let i = 0; i < installer.projects.length; i++) {
        const p = installer.projects[i];
        if (p?.photo_url && (!p.local_path || !fs.existsSync(p.local_path))) {
          try {
            const r = await fetch(p.photo_url);
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              const localPath = path.join(TMP, `${installerId}_project_${i}.jpg`);
              fs.writeFileSync(localPath, buf);
              p.local_path = localPath;
              console.log(`Restored project ${i} photo (${buf.length} bytes)`);
            }
          } catch(e) { console.log(`Could not restore project ${i}:`, e.message); }
        }
      }
    }

    const photoPath = path.join(jobDir, 'roof_marked.jpg');
    fs.writeFileSync(photoPath, req.file.buffer);
    console.log(`Photo: ${req.file.buffer.length} bytes`);
    console.log(`Job ${jobId}: Generating AI image...`);

    const prompt = buildPrompt(systemKw, panelCount, legHeights, roofType);
    const { toFile } = await import('openai');
    const imageFile = await toFile(fs.createReadStream(photoPath), 'roof_marked.jpg', { type: 'image/jpeg' });

    const aiResult = await openai.images.edit({
      model:   'gpt-image-2',
      image:   imageFile,
      prompt,
      n:       1,
      size:    '1024x1024',
      quality: 'medium',
    });

    if (!aiResult.data?.[0]?.b64_json) throw new Error('OpenAI returned empty image data');
    const imageBuffer = Buffer.from(aiResult.data[0].b64_json, 'base64');
    fs.writeFileSync(path.join(jobDir, 'result.jpg'), imageBuffer);

    console.log(`Job ${jobId}: Uploading AI image...`);
    const aiImageUrl = await uploadToCloudinary(imageBuffer, 'solarscan/results', `result_${jobId}`, 'image');

    const fin = calcFinancials(systemKw, monthlyBill, quotedPrice, subsidyAmount);

    console.log(`Job ${jobId}: Generating PDF...`);
    const pdfPath = path.join(jobDir, 'proposal.pdf');
    const pdfBuffer = await generatePDF({ installer, customer, fin, panelBrand, inverterBrand, panelCount, aiImageUrl, jobId, pdfPath });

    console.log(`PDF size: ${pdfBuffer.length} bytes`);
    if (!pdfBuffer || pdfBuffer.length < 1000) throw new Error(`PDF too small: ${pdfBuffer?.length || 0} bytes`);

    console.log(`Job ${jobId}: Uploading PDF...`);
    const pdfUrl = await uploadToCloudinary(pdfBuffer, 'solarscan/pdfs', `proposal_${jobId}`, 'raw');

    res.json({ success: true, job_id: jobId, image_url: aiImageUrl, pdf_url: pdfUrl, financials: fin });

  } catch (err) {
    console.error('Generate quote error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    setTimeout(() => fs.rmSync(jobDir, { recursive: true, force: true }), 600000);
  }
});

// ── PDF GENERATION ────────────────────────────────────────────────────────────

async function generatePDF({ installer, customer, fin, panelBrand, inverterBrand, panelCount, aiImageUrl, jobId, pdfPath }) {

  async function imgToBase64(url, localPath) {
    let buf = null;
    if (localPath && fs.existsSync(localPath)) {
      try { buf = fs.readFileSync(localPath); console.log(`Image from local: ${localPath} (${buf.length} bytes)`); }
      catch(e) { console.log('Local read failed:', e.message); }
    }
    if (!buf && url) {
      try {
        const r = await fetch(url);
        if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); console.log(`Image from URL: ${url} (${buf.length} bytes)`); }
      } catch(e) { console.log('URL fetch error:', e.message); }
    }
    if (!buf) return null;
    if (url && url.includes('res.cloudinary.com') && url.includes('/upload/')) {
      try {
        const compressedUrl = url.replace('/upload/', '/upload/w_600,h_400,c_fill,q_60,f_jpg/');
        const r = await fetch(compressedUrl);
        if (r.ok) {
          const compBuf = Buffer.from(await r.arrayBuffer());
          console.log(`Compressed: ${compBuf.length} bytes (was ${buf.length})`);
          return `data:image/jpeg;base64,${compBuf.toString('base64')}`;
        }
      } catch(e) { console.log('Compression failed:', e.message); }
    }
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  console.log('Fetching images as base64...');
  console.log('Project photo_urls:', (installer.projects || []).map(p => p?.photo_url));
  console.log('Project local_paths:', (installer.projects || []).map(p => p?.local_path));

  const [aiImageBase64, ...projectPhotoBase64] = await Promise.all([
    imgToBase64(aiImageUrl, null),
    ...(installer.projects || []).map(p => imgToBase64(p?.photo_url, p?.local_path)),
  ]);

  const aiImageSrc = aiImageBase64 || aiImageUrl;
  const projects   = (installer.projects || []).map((p, i) => ({
    ...p,
    photo_url: projectPhotoBase64[i] || null,
  }));

  console.log('Base64 results:', projects.map((p,i) => `project${i}: ${p.photo_url ? p.photo_url.slice(0,30) : 'NULL'}`));

  const today      = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const validDate  = new Date(Date.now() + 30*24*60*60*1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const proposalNo = `SP-${new Date().getFullYear()}-${jobId.toUpperCase()}`;

  // FIX 3 & 4: Horizontal project card — 3 per page, compact
  const projectCard = (p, idx) => {
    if (!p || !p.name) return `
      <div style="display:grid;grid-template-columns:200px 1fr;min-height:155px;background:white;border:2px solid #C8E6C9;border-radius:14px;overflow:hidden;margin-bottom:12px;">
        <div style="background:linear-gradient(135deg,#1B5E20,#2E7D32);display:flex;flex-direction:column;justify-content:flex-end;padding:14px;">
          <div style="font-size:15px;font-weight:900;color:white;">Project ${idx+1}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.7);margin-top:3px;">No photo uploaded</div>
        </div>
        <div style="padding:16px 20px;"><div style="font-size:12px;color:#4A6741;">No project data added</div></div>
      </div>`;

    const imgBg = p.photo_url
      ? `background-image:linear-gradient(to top,rgba(0,0,0,0.6),rgba(0,0,0,0.05)),url('${p.photo_url}');background-size:cover;background-position:center;`
      : `background:linear-gradient(135deg,#1B5E20,#2E7D32);`;

    return `
      <div style="display:grid;grid-template-columns:200px 1fr;min-height:155px;background:white;border:2px solid #C8E6C9;border-radius:14px;overflow:hidden;margin-bottom:12px;box-shadow:0 3px 10px rgba(0,0,0,0.06);">
        <div style="${imgBg}display:flex;flex-direction:column;justify-content:flex-end;padding:14px;">
          <div style="font-size:15px;font-weight:900;color:white;">${p.name || ''}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.85);margin-top:2px;">@ ${p.city || ''}</div>
        </div>
        <div style="padding:14px 18px;display:flex;flex-direction:column;">
          <div style="display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap;">
            <span style="background:#F9A825;color:#1B5E20;font-size:10px;font-weight:900;padding:2px 10px;border-radius:20px;">${p.cap || p.capacity || '5 kW'} System</span>
            <span style="background:#F1F8E9;color:#2E7D32;font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px;border:1px solid #C8E6C9;">${p.roof || 'Flat RCC'}</span>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#4A6741;font-weight:700;margin-bottom:7px;">
            <span>Gen: ${p.kwh || '7,500 kWh/yr'}</span>
            <span>Installed: ${p.date || '2025'}</span>
            <span>Rating: ${p.rating || '4.9/5'}</span>
          </div>
          ${p.quote ? `
            <div style="margin-top:auto;border-top:1px solid #C8E6C9;padding-top:8px;font-size:11px;color:#4A6741;font-style:italic;line-height:1.4;">
              "${p.quote}"
              <span style="font-style:normal;font-weight:900;color:#2E7D32;display:block;margin-top:3px;">— ${p.quote_author || p.quoteAuthor || ''}</span>
            </div>` : ''}
        </div>
      </div>`;
  };

  // FIX 2: Section header — no emoji, clean text
  const sectionHeader = (subtitle, title) => `
    <div style="background:#1B5E20;padding:28px 48px;color:white;">
      <div style="font-size:11px;font-weight:700;color:#F9A825;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">${subtitle}</div>
      <div style="font-size:28px;font-weight:900;">${title}</div>
    </div>`;

  // FIX 1: Chart with kWh label (not u)
  const monthlyData = [
    {m:'Jan',v:450},{m:'Feb',v:520},{m:'Mar',v:650},{m:'Apr',v:720},
    {m:'May',v:750},{m:'Jun',v:750},{m:'Jul',v:600},{m:'Aug',v:550},
    {m:'Sep',v:580},{m:'Oct',v:620},{m:'Nov',v:500},{m:'Dec',v:450}
  ];
  const unitRateForChart = fin.yearlyKwh > 0 ? fin.annualSaving / fin.yearlyKwh : 6;
  const chartBars = monthlyData.map(d => {
    const saving = Math.round(d.v * unitRateForChart);
    const savingShort = saving >= 1000 ? `&#8377;${(saving/1000).toFixed(1)}k` : `&#8377;${saving}`;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;flex:1;">
        <div style="font-size:8px;color:#1B5E20;font-weight:900;margin-bottom:1px;white-space:nowrap;">${savingShort}</div>
        <div style="font-size:7px;color:#4A6741;font-weight:700;margin-bottom:3px;white-space:nowrap;">${d.v} kWh</div>
        <div style="width:14px;height:${Math.round((d.v/750)*70)}px;background:linear-gradient(to top,#8BC34A,#1B5E20);border-radius:2px 2px 0 0;"></div>
        <div style="font-size:7px;font-weight:700;color:#4A6741;margin-top:3px;">${d.m}</div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,'Segoe UI',Arial,sans-serif; background:white; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page { width:210mm; min-height:297mm; position:relative; overflow:hidden; page-break-after:always; display:flex; flex-direction:column; }
  table { border-collapse:collapse; width:100%; }
</style>
</head>
<body>

<!-- PAGE 0: COVER — branded summary replacing generic marketing page -->
<div class="page" style="background:#F1F8E9;">
  <div style="position:absolute;top:0;left:0;width:100%;height:52%;background:#1B5E20;z-index:0;"></div>
  <div style="padding:44px;display:flex;flex-direction:column;height:100%;position:relative;z-index:1;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
      <div style="display:flex;align-items:center;gap:10px;color:white;">
        ${installer.logo_url
          ? `<img src="${installer.logo_url}" style="height:44px;width:44px;border-radius:50%;object-fit:cover;border:2px solid #8BC34A;" />`
          : `<div style="width:44px;height:44px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#1B5E20;">S</div>`}
        <div>
          <div style="font-weight:900;font-size:20px;line-height:1;">${installer.company_name || 'SURYA POWER'}</div>
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.8;">Solar Solutions</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="color:#C8E6C9;font-size:12px;">Proposal No: ${proposalNo}</div>
        <div style="color:#C8E6C9;font-size:12px;">Date: ${today}</div>
        <div style="color:#C8E6C9;font-size:12px;">Valid Until: ${validDate}</div>
      </div>
    </div>
    <div style="margin-bottom:18px;">
      <div style="color:#F9A825;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:11px;margin-bottom:8px;">India's Trusted Rooftop Solar EPC</div>
      <div style="font-size:44px;font-weight:900;color:white;line-height:1.05;">CLEAN ENERGY PROPOSAL</div>
    </div>
    <div style="flex:1;width:100%;border:4px solid #8BC34A;border-radius:18px;overflow:hidden;position:relative;min-height:180px;">
      <img src="${aiImageSrc}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.3),transparent);"></div>
    </div>
    <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
      <div style="background:white;padding:12px;border-radius:10px;border:1px solid #C8E6C9;text-align:center;">
        <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:3px;">Prepared For</div>
        <div style="font-size:13px;font-weight:900;color:#1A2F1A;">${customer.name}</div>
      </div>
      <div style="background:#1B5E20;padding:12px;border-radius:10px;text-align:center;">
        <div style="font-size:9px;color:#8BC34A;font-weight:700;text-transform:uppercase;margin-bottom:3px;">System Size</div>
        <div style="font-size:17px;font-weight:900;color:#F9A825;">${fin.systemKw} kW</div>
      </div>
      <div style="background:white;padding:12px;border-radius:10px;border:1px solid #C8E6C9;text-align:center;">
        <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:3px;">Net Payable</div>
        <div style="font-size:13px;font-weight:900;color:#1B5E20;">&#8377;${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:white;padding:12px;border-radius:10px;border:1px solid #C8E6C9;text-align:center;">
        <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:3px;">Annual Savings</div>
        <div style="font-size:13px;font-weight:900;color:#2E7D32;">&#8377;${fin.annualSaving.toLocaleString('en-IN')}</div>
      </div>
    </div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;background:linear-gradient(to right,#FFF8E1,#F1F8E9);border:1px solid #C8E6C9;padding:10px 14px;border-radius:10px;">
      <div style="width:26px;height:26px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#1B5E20;font-size:11px;flex-shrink:0;">S</div>
      <span style="font-weight:700;color:#1B5E20;font-size:12px;">PM Surya Ghar: Muft Bijli Yojana — Subsidy of &#8377;${fin.subsidyAmount.toLocaleString('en-IN')} applicable</span>
      <span style="margin-left:auto;font-weight:900;color:#2E7D32;font-size:13px;">&#10003;</span>
    </div>
  </div>
</div>

<!-- PAGE 1: WELCOME LETTER -->
<div class="page" style="background:#F1F8E9;padding:44px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid #1B5E20;padding-bottom:18px;margin-bottom:28px;">
    <div style="display:flex;align-items:center;gap:10px;color:#1B5E20;">
      ${installer.logo_url
        ? `<img src="${installer.logo_url}" style="height:34px;width:34px;border-radius:50%;object-fit:cover;" />`
        : `<div style="width:34px;height:34px;background:#1B5E20;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:15px;color:white;">S</div>`}
      <div>
        <div style="font-weight:900;font-size:17px;">${installer.company_name || 'SURYA POWER'}</div>
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;">Solar Solutions</div>
      </div>
    </div>
    <div style="text-align:right;font-size:12px;color:#4A6741;font-weight:600;">
      <div>${today}</div><div>Ref: ${proposalNo}</div>
    </div>
  </div>
  <div style="font-size:22px;font-weight:900;color:#1A2F1A;margin-bottom:18px;">Dear ${customer.name},</div>
  <div style="background:linear-gradient(to right,#FFF8E1,#F1F8E9);border:2px solid #8BC34A;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:20px;">
    <div style="width:44px;height:44px;background:white;border-radius:50%;border:3px solid #F9A825;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;color:#F9A825;flex-shrink:0;">S</div>
    <div>
      <div style="font-size:15px;font-weight:900;color:#1B5E20;">PM Surya Ghar: Muft Bijli Yojana</div>
      <div style="font-size:12px;font-weight:700;color:#2E7D32;margin-top:2px;">Empanelled and Authorized Vendor</div>
    </div>
    <div style="margin-left:auto;background:linear-gradient(to right,#F9A825,#FF8F00);color:white;font-weight:900;padding:7px 12px;border-radius:8px;font-size:11px;">SUBSIDY READY</div>
  </div>
  <div style="font-size:14px;color:#4A6741;line-height:1.8;margin-bottom:16px;">Welcome to <strong style="color:#1B5E20;">${installer.company_name || 'Surya Power Solutions'}</strong>! We are excited to present your customised <strong>${fin.systemKw} kW solar system</strong>. As an authorised PM Surya Ghar partner with over ${installer.years || '8'}+ years of excellence, we ensure a seamless transition to clean, affordable energy.</div>
  <div style="font-size:14px;color:#4A6741;line-height:1.8;margin-bottom:16px;">This proposal outlines your exact system specifications, financial savings, and the straightforward roadmap to claiming your <strong style="color:#1B5E20;">&#8377;${fin.subsidyAmount.toLocaleString('en-IN')}</strong> government subsidy. With this installation you will drastically cut your monthly bills while locking in energy security for decades.</div>
  <div style="font-size:14px;color:#4A6741;line-height:1.8;">Please review the detailed projections inside. Our technical team is ready to answer any questions and help you take the next step.</div>
  <div style="margin-top:24px;color:#1B5E20;font-weight:700;">Warm Regards,</div>
  <div style="font-family:Georgia,serif;font-size:30px;color:#2E7D32;opacity:0.9;margin-top:6px;">${installer.company_name || 'Surya Power'}</div>
  <div style="font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
  <div style="font-size:12px;color:#8BC34A;font-weight:700;">${installer.email || ''}</div>
  <div style="margin-top:auto;padding-top:20px;display:flex;justify-content:center;">
    <div style="background:white;border:1px solid #C8E6C9;border-radius:12px;padding:12px 22px;text-align:center;">
      <div style="font-size:11px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Authorized and Empanelled</div>
      <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:7px 12px;border-radius:20px;">
        <div style="width:18px;height:18px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:9px;color:#1B5E20;">S</div>
        <span style="font-weight:700;color:#1B5E20;font-size:12px;">PM Surya Ghar: Muft Bijli Yojana</span>
        <span style="color:#8BC34A;font-weight:900;">&#10003;</span>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 2: PROJECTS 1-3 (3 horizontal cards) -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:18px 44px;display:flex;flex-direction:column;flex:1;">
    <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;display:flex;justify-content:space-between;align-items:center;padding:11px 18px;margin-bottom:16px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;width:100%;height:4px;background:linear-gradient(to right,#F9A825,#8BC34A);"></div>
      ${[
        {label:'In Business',   value: installer.years    || '8+',   letter:'Y', bg:'#FFF8E1', col:'#F9A825'},
        {label:'Installations', value: installer.total_kw || '450+', letter:'I', bg:'#E8F5E9', col:'#1B5E20'},
        {label:'MW Capacity',   value: '2.1 MW',                     letter:'C', bg:'#E8F5E9', col:'#1B5E20'},
        {label:'Rating',        value: '4.9/5',                      letter:'R', bg:'#FFF8E1', col:'#F9A825'},
      ].map((s,i) => `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;background:${s.bg};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:${s.col};">${s.letter}</div>
          <div>
            <div style="font-size:16px;font-weight:900;color:#1B5E20;">${s.value}</div>
            <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${s.label}</div>
          </div>
        </div>
        ${i<3?'<div style="width:1px;height:34px;background:#C8E6C9;"></div>':''}`).join('')}
    </div>
    <div style="flex:1;">
      ${projectCard(projects[0],0)}
      ${projectCard(projects[1],1)}
      ${projectCard(projects[2],2)}
    </div>
  </div>
</div>

<!-- PAGE 3: PROJECTS 4-6 + COMMITMENTS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:18px 44px;display:flex;flex-direction:column;flex:1;">
    <div style="flex:1;">
      ${projectCard(projects[3],3)}
      ${projectCard(projects[4],4)}
      ${projectCard(projects[5],5)}
    </div>
    <div style="background:#1B5E20;color:white;border-radius:12px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
      ${[
        {letter:'&#10003;', label:'MNRE Empanelled',    sub:'Installer'},
        {letter:'T',         label:'Tier-1 Brands Only', sub:'Waaree, Adani, Vikram'},
        {letter:'A',         label:'5 Year Free AMC',    sub:'Included'},
      ].map((c,i)=>`
        <div style="display:flex;align-items:center;gap:10px;flex:1;justify-content:center;">
          <div style="background:#8BC34A;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#1B5E20;font-weight:900;font-size:13px;">${c.letter}</div>
          <div style="text-align:center;">
            <div style="font-weight:700;font-size:12px;">${c.label}</div>
            <div style="font-size:10px;opacity:0.8;">${c.sub}</div>
          </div>
        </div>
        ${i<2?'<div style="width:1px;height:32px;background:rgba(255,255,255,0.2);"></div>':''}`).join('')}
    </div>
  </div>
</div>

<!-- PAGE 4: SYSTEM DESIGN -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Technical Overview', 'Proposed System Design')}
  <div style="padding:22px 44px;">
    <div style="width:100%;height:300px;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;margin-bottom:18px;position:relative;">
      <img src="${aiImageSrc}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.4),transparent);"></div>
      <div style="position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:white;font-weight:700;font-size:12px;background:rgba(0,0,0,0.5);padding:5px 14px;border-radius:20px;">AI Generated — Your Actual Roof View</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
      ${[
        {title:'System Size',  value:`${fin.systemKw} kW`,                              letter:'P'},
        {title:'Solar Panels', value:`${panelCount}x ${panelBrand.split(' ')[0]} 550W`, letter:'S'},
        {title:'Orientation',  value:'South / 25 deg Tilt',                             letter:'O'},
        {title:'Connection',   value:'On-Grid Net Meter',                               letter:'G'},
      ].map(s=>`
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:13px;">
          <div style="width:26px;height:26px;background:#E8F5E9;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:#1B5E20;margin-bottom:7px;">${s.letter}</div>
          <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">${s.title}</div>
          <div style="font-size:13px;font-weight:900;color:#1A2F1A;">${s.value}</div>
        </div>`).join('')}
    </div>
    <div style="background:white;border:2px solid #8BC34A;border-radius:14px;padding:13px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="background:linear-gradient(135deg,#8BC34A,#2E7D32);padding:11px;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:white;">E</div>
        <div>
          <div style="font-size:15px;font-weight:900;color:#1B5E20;">Environmental Impact</div>
          <div style="font-size:12px;font-weight:700;color:#4A6741;">Offsets ${fin.co2} Tonnes of CO2 emissions annually</div>
        </div>
      </div>
      <div style="background:#F1F8E9;padding:10px 14px;border-radius:12px;border:1px solid #C8E6C9;text-align:right;">
        <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;">Equivalent to planting</div>
        <div style="font-size:22px;font-weight:900;color:#1B5E20;">${fin.trees} Trees / Year</div>
      </div>
    </div>
    <div style="background:white;border-radius:14px;overflow:hidden;border:2px solid #C8E6C9;">
      <div style="background:#1B5E20;padding:10px 18px;color:white;font-weight:700;font-size:13px;">Detailed Specifications</div>
      ${[
        ['System Type',           'Grid-Tied (On-Grid) Rooftop Solar PV System'],
        ['Panel Model',           `${panelBrand} 550W Monocrystalline PERC Half-Cut`],
        ['Inverter Model',        `${inverterBrand} ${fin.systemKw}kW String Inverter (Wi-Fi Enabled)`],
        ['Mounting Structure',    'Hot-Dip Galvanized (HDG) MS, 25 deg Optimal Tilt'],
        ['Estimated Annual Gen.', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh (Units) per year`],
      ].map((r,i)=>`
        <div style="display:flex;border-bottom:1px solid #C8E6C9;background:${i%2===0?'#F1F8E9':'white'};">
          <div style="padding:10px 18px;width:40%;font-size:12px;font-weight:700;color:#4A6741;">${r[0]}</div>
          <div style="padding:10px 18px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[1]}</div>
        </div>`).join('')}
    </div>
  </div>
</div>

<!-- PAGE 5: FINANCIAL SAVINGS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Return on Investment', 'Financial Savings Analysis')}
  <div style="padding:22px 44px;">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:18px;">
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:13px;">
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;">Total System Cost</div>
        <div style="font-size:17px;font-weight:900;color:#1A2F1A;margin-top:5px;">&#8377;${fin.quotedPrice.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#E8F5E9;border:2px solid #8BC34A;border-radius:12px;padding:13px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;right:0;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:3px 8px;border-radius:0 0 0 8px;">APPROVED</div>
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">Subsidy</div>
        <div style="font-size:17px;font-weight:900;color:#2E7D32;margin-top:5px;">&#8377;${fin.subsidyAmount.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#1B5E20;border-radius:12px;padding:13px;">
        <div style="font-size:10px;font-weight:700;color:#8BC34A;text-transform:uppercase;letter-spacing:1px;">Net Investment</div>
        <div style="font-size:20px;font-weight:900;color:white;margin-top:5px;">&#8377;${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#F1F8E9;border:2px solid #C8E6C9;border-radius:12px;padding:13px;">
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">Payback Period</div>
        <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-top:5px;">${fin.payback} Years</div>
      </div>
    </div>
    <div style="display:flex;gap:18px;">
      <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:14px;overflow:hidden;">
        <div style="background:#E8F5E9;padding:11px 16px;border-bottom:2px solid #C8E6C9;">
          <div style="font-weight:900;color:#1B5E20;font-size:13px;">Savings Projections</div>
        </div>
        ${[
          ['Annual Generation',   `${fin.yearlyKwh.toLocaleString('en-IN')} kWh`,                   '#1A2F1A'],
          ['Current Monthly Bill',`&#8377;${fin.monthlyBefore.toLocaleString('en-IN')}`,            '#1A2F1A'],
          ['Monthly Savings',     `&#8377;${Math.round(fin.annualSaving/12).toLocaleString('en-IN')}`,'#2E7D32'],
          ['Annual Savings',      `&#8377;${fin.annualSaving.toLocaleString('en-IN')}`,             '#2E7D32'],
          ['10 Year Savings',     `&#8377;${(fin.annualSaving*10).toLocaleString('en-IN')}`,        '#1A2F1A'],
          ['25 Year Savings',     `&#8377;${(fin.annualSaving*25).toLocaleString('en-IN')}`,        '#1A2F1A'],
          ['25 Year Net Profit',  `&#8377;${fin.saving25yr.toLocaleString('en-IN')}`,               '#F9A825'],
        ].map(r=>`
          <div style="display:flex;justify-content:space-between;padding:9px 16px;border-bottom:1px solid #C8E6C9;">
            <span style="font-size:12px;color:#4A6741;font-weight:600;">${r[0]}</span>
            <span style="font-size:12px;font-weight:900;color:${r[2]};">${r[1]}</span>
          </div>`).join('')}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:11px;">
        <div style="display:flex;gap:10px;">
          <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:12px;padding:12px;text-align:center;">
            <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Before Solar</div>
            <div style="font-size:19px;font-weight:900;color:#1A2F1A;">&#8377;${fin.monthlyBefore.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#4A6741;margin-top:3px;">per month</div>
          </div>
          <div style="flex:1;background:#F1F8E9;border:2px solid #8BC34A;border-radius:12px;padding:12px;text-align:center;position:relative;overflow:hidden;">
            <div style="position:absolute;top:-4px;right:-16px;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:4px 24px;transform:rotate(45deg);">SAVE ${fin.savePct}%</div>
            <div style="font-size:10px;color:#2E7D32;font-weight:700;text-transform:uppercase;margin-bottom:4px;">After Solar</div>
            <div style="font-size:19px;font-weight:900;color:#1B5E20;">&#8377;${fin.monthlyAfter.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#2E7D32;margin-top:3px;">per month</div>
          </div>
        </div>
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:13px;flex:1;">
          <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Monthly Generation & Savings</div>
          <div style="display:flex;align-items:flex-end;gap:2px;height:115px;border-bottom:2px solid #E8F5E9;padding-bottom:4px;">
            ${chartBars}
          </div>
          <div style="font-size:9px;color:#4A6741;font-weight:600;margin-top:5px;text-align:center;">Savings estimated from annual generation and current bill assumptions</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 6: BILL OF MATERIALS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Technical Delivery', 'Bill of Materials (BOM)')}
  <div style="padding:22px 44px;">
    <div style="background:white;border-radius:14px;overflow:hidden;border:2px solid #C8E6C9;margin-bottom:16px;">
      <table>
        <thead>
          <tr style="background:#1B5E20;color:white;">
            <th style="padding:11px 16px;text-align:left;font-size:11px;text-transform:uppercase;width:22%;">Component</th>
            <th style="padding:11px 16px;text-align:left;font-size:11px;text-transform:uppercase;width:44%;">Brand and Specification</th>
            <th style="padding:11px 16px;text-align:center;font-size:11px;text-transform:uppercase;width:10%;">Qty</th>
            <th style="padding:11px 16px;text-align:left;font-size:11px;text-transform:uppercase;width:24%;">Warranty</th>
          </tr>
        </thead>
        <tbody>
          ${[
            [panelBrand,     `${panelBrand} 550W Mono PERC Half Cut`,               `${panelCount} Nos`, '25yr Performance / 10yr Product'],
            ['Inverter',     `${inverterBrand} ${fin.systemKw}kW Wi-Fi String Inverter IP65`, '1 No', '10 Years'],
            ['Structure',    'GI/MS Hot Dip Galvanized 25 deg MNRE Approved',        '1 Set',             '10 Years'],
            ['DC Cables',    '4mm UV Resistant with MC4 Connectors',                 'As Req.',           '10 Years'],
            ['AC DB Box',    'IP65 Enclosure with SPD, MCB, Isolator',               '1 No',              '2 Years'],
            ['Earthing & LA','Maintenance-free GI Plate and Lightning Arrester',     '1 Set',             '5 Years'],
            ['Net Meter',    'Bidirectional DISCOM Approved Meter',                  '1 No',              'Per DISCOM'],
          ].map((r,i)=>`
            <tr style="border-bottom:1px solid #C8E6C9;background:${i%2===0?'white':'#F1F8E9'};">
              <td style="padding:10px 16px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
              <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
              <td style="padding:10px 16px;font-size:12px;font-weight:900;color:#1B5E20;text-align:center;background:#E8F5E9;">${r[2]}</td>
              <td style="padding:10px 16px;font-size:12px;font-weight:900;color:#2E7D32;">${r[3]}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="background:white;border:2px solid #8BC34A;border-radius:14px;padding:14px 18px;display:flex;gap:14px;">
      <div style="background:#E8F5E9;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#1B5E20;flex-shrink:0;align-self:flex-start;">B</div>
      <div>
        <div style="font-size:14px;font-weight:900;color:#1B5E20;margin-bottom:5px;">Balance of System (BOS) Inclusion Note:</div>
        <div style="font-size:12px;color:#4A6741;font-weight:600;line-height:1.6;">All necessary civil work for foundation blocks, PVC conduits, junction boxes, cable trays, and minor hardware required for a safe, code-compliant installation are fully included in the system cost.</div>
      </div>
    </div>
  </div>
</div>

<!-- FIX 5: PAGE 7: PRICING — Final Quotation FIRST, then milestones, then bank -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Commercials', 'Pricing and Payment Terms')}
  <div style="padding:22px 44px;display:flex;flex-direction:column;gap:16px;">

    <div style="background:white;border:4px solid #1B5E20;border-radius:14px;padding:22px;position:relative;margin-top:10px;">
      <div style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:#1B5E20;color:white;padding:5px 18px;border-radius:20px;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Final Quotation</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-top:5px;">
        <span style="font-size:15px;font-weight:700;color:#4A6741;">Total System Cost</span>
        <span style="font-size:17px;font-weight:900;color:#1A2F1A;">&#8377; ${fin.quotedPrice.toLocaleString('en-IN')}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:14px;border-bottom:2px dashed #C8E6C9;color:#2E7D32;">
        <span style="font-size:13px;font-weight:700;">Less: PM Surya Ghar Subsidy</span>
        <span style="font-size:15px;font-weight:900;">- &#8377; ${fin.subsidyAmount.toLocaleString('en-IN')}</span>
      </div>
      <div style="background:#F1F8E9;padding:14px 18px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;border:1px solid #C8E6C9;">
        <div>
          <div style="font-size:11px;font-weight:900;color:#1B5E20;text-transform:uppercase;letter-spacing:1px;">Net Amount Payable</div>
          <div style="font-size:10px;color:#4A6741;margin-top:2px;">*Excluding GST as applicable</div>
        </div>
        <div style="font-size:36px;font-weight:900;color:#1B5E20;">&#8377; ${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
    </div>

    <div>
      <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:10px;">Payment Milestones</div>
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;overflow:hidden;">
        <table>
          <thead><tr style="background:#E8F5E9;color:#2E7D32;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">
            <th style="padding:10px 16px;text-align:left;">Milestone</th>
            <th style="padding:10px 16px;text-align:left;">Timeline</th>
            <th style="padding:10px 16px;text-align:right;">Amount</th>
          </tr></thead>
          <tbody>
            ${[
              ['20% Advance',           'On Proposal Signing (Due Today)',     `&#8377; ${fin.advance.toLocaleString('en-IN')}`],
              ['70% Material Readiness','Before Material Delivery (Day 3-5)', `&#8377; ${fin.material.toLocaleString('en-IN')}`],
              ['10% Commissioning',     'After Meter Install and Testing',     `&#8377; ${fin.final.toLocaleString('en-IN')}`],
            ].map((r,i)=>`
              <tr style="border-top:1px solid #C8E6C9;background:${i%2===1?'#F1F8E9':'white'};">
                <td style="padding:11px 16px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
                <td style="padding:11px 16px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
                <td style="padding:11px 16px;font-size:12px;font-weight:900;color:#1A2F1A;text-align:right;">${r[2]}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div style="background:#1B5E20;color:white;padding:16px;border-radius:14px;">
        <div style="font-size:11px;font-weight:900;color:#F9A825;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.2);">Bank Details</div>
        <div style="font-size:12px;margin-bottom:7px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Bank:</span>${installer.bank_name || 'HDFC Bank'}</div>
        <div style="font-size:12px;margin-bottom:7px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Account:</span>${installer.account_no || 'XXXX XXXX XXXX'}</div>
        <div style="font-size:12px;margin-bottom:7px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">IFSC:</span>${installer.ifsc || 'HDFC0001234'}</div>
        <div style="font-size:12px;font-weight:900;color:#F9A825;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.2);">UPI: ${installer.upi || 'contact@suryapower.com'}</div>
      </div>
      <div style="background:white;border:2px solid #8BC34A;border-radius:14px;padding:16px;">
        <div style="font-size:14px;font-weight:900;color:#1B5E20;margin-bottom:8px;">Important Note</div>
        <div style="font-size:12px;color:#4A6741;line-height:1.7;">GST at prevailing rates will be charged extra. The PM Surya Ghar subsidy of &#8377;${fin.subsidyAmount.toLocaleString('en-IN')} will be credited <strong style="color:#1B5E20;">directly to your linked bank account</strong> by the government.</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 8: NEXT STEPS + FOOTER -->
<div class="page" style="background:#F1F8E9;padding:44px;display:flex;flex-direction:column;">
  <div style="margin-bottom:28px;">
    <div style="font-size:24px;font-weight:900;color:#1B5E20;text-align:center;margin-bottom:24px;">Your Journey to Clean Energy</div>
    <div style="position:relative;display:flex;justify-content:space-between;align-items:flex-start;">
      <div style="position:absolute;top:28px;left:0;width:100%;height:4px;background:#C8E6C9;border-radius:2px;z-index:0;"></div>
      ${[
        {no:1,label:'Sign Proposal'},{no:2,label:'20% Advance'},
        {no:3,label:'Site Survey'}, {no:4,label:'Installation'},
        {no:5,label:'Net Metering'},{no:6,label:'Subsidy Credit'},
      ].map(s=>`
        <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:56px;height:56px;border-radius:50%;background:#1B5E20;color:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;border:4px solid #F1F8E9;">${s.no}</div>
          <div style="font-size:10px;font-weight:900;color:#2E7D32;text-align:center;width:70px;line-height:1.3;text-transform:uppercase;">${s.label}</div>
        </div>`).join('')}
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:24px;">
    <div style="background:white;padding:20px;border-radius:14px;border:2px solid #C8E6C9;border-top:8px solid #8BC34A;">
      <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:12px;">Scope Included</div>
      ${['All Solar Materials and Components','End-to-End Installation and Wiring','Custom Mounting Structure','Subsidy Documentation and Portal Entry','Net Meter Application Process','1 Year Free Workmanship Warranty'].map(s=>`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#8BC34A;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>`).join('')}
    </div>
    <div style="background:white;padding:20px;border-radius:14px;border:2px solid #C8E6C9;border-top:8px solid #4A6741;">
      <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:12px;">Scope Excluded</div>
      ${['Official DISCOM / Utility Fees','Major Pre-existing Electrical Upgrades','Major Civil Roof Repairs before installation','Water arrangement for panel cleaning'].map(s=>`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#4A6741;opacity:0.5;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>`).join('')}
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;padding:0 28px;margin-bottom:24px;">
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${customer.name}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Customer Acceptance and Date</div>
    </div>
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Authorised Signatory — ${today}</div>
    </div>
  </div>
  <!-- FIX 6: Footer — normal letter-spacing, no text-transform uppercase -->
  <div style="background:#1B5E20;margin:-44px;margin-top:auto;padding:32px 44px;color:white;">
    <div style="font-size:26px;font-weight:900;text-align:center;margin-bottom:8px;">Thank You for Choosing Clean Energy</div>
    <div style="text-align:center;color:#8BC34A;font-weight:700;font-size:13px;margin-bottom:18px;">Together we are building a sustainable India.</div>
    <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(139,195,74,0.3);border-bottom:1px solid rgba(139,195,74,0.3);padding:12px 0;margin-bottom:12px;">
      <span>Tel: ${installer.phone || '98765 43210'}</span>
      <span>Email: ${installer.email || 'info@suryapower.com'}</span>
      <span>Web: ${installer.website || 'www.suryapower.com'}</span>
    </div>
    <div style="text-align:center;font-size:11px;color:#C8E6C9;font-weight:600;letter-spacing:0.5px;">
      ${installer.company_name || 'Surya Power Solutions'} | GST: ${installer.gst || 'XXXXXXXXXXXX'} | Powered by SolarQuote
    </div>
  </div>
</div>

</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process',
           '--disable-web-security','--disable-features=IsolateOrigins,site-per-process'],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 90000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const pdfBuffer = await page.pdf({
    format:          'A4',
    printBackground: true,
    margin:          { top: 0, right: 0, bottom: 0, left: 0 },
  });

  await browser.close();
  console.log(`PDF generated: ${pdfBuffer.length} bytes`);
  fs.writeFileSync(pdfPath, pdfBuffer);
  return pdfBuffer;
}

// ── SERVE ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`solarscan running on port ${PORT}`);
});
