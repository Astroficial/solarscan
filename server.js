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

// &#8377;&#8377; HELPERS &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

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
    `The camera was pointing NORTH. Therefore all solar panels must face TRUE SOUTH &#8377; directly toward the camera. The full front glass surface of all panels must be visible. ` +
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

// &#8377;&#8377; CLOUDINARY UPLOAD &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

async function uploadToCloudinary(buffer, folder, publicId, resourceType = 'image') {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
  const isProfile = publicId.includes('profile');
  const isPdf     = publicId.includes('proposal');
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

// &#8377;&#8377; SAVE PROFILE &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

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
        // Upload to Cloudinary
        meta.photo_url = await uploadToCloudinary(
          buf, `solarscan/${installerId}/projects`, `project_${i}`
        );
        // Save locally for PDF generation
        const localPath = path.join(TMP, `${installerId}_project_${i}.jpg`);
        fs.writeFileSync(localPath, buf);
        meta.local_path = localPath;
      }
      profile.projects[i] = meta;
    }

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    // Persist to Cloudinary so it survives redeploys
    const profileBuf = Buffer.from(JSON.stringify(profile, null, 2));
    await uploadToCloudinary(profileBuf, `solarscan/${installerId}`, 'profile', 'raw');

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// &#8377;&#8377; LOAD PROFILE &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

app.get('/api/load-profile', async (req, res) => {
  try {
    const installerId = req.query.installer_id || 'default';
    const profilePath = path.join(TMP, `profile_${installerId}.json`);

    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      return res.json({ success: true, profile });
    }

    // Fallback: restore from Cloudinary
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

// &#8377;&#8377; GENERATE QUOTE &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

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

    // Load installer profile
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

    // Restore local photo files if missing (after redeploy)
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
              console.log(`Restored project ${i} photo from Cloudinary (${buf.length} bytes)`);
            }
          } catch(e) {
            console.log(`Could not restore project ${i} photo:`, e.message);
          }
        }
      }
    }

    // Save photo
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

// &#8377;&#8377; PDF GENERATION &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

async function generatePDF({ installer, customer, fin, panelBrand, inverterBrand, panelCount, aiImageUrl, jobId, pdfPath }) {

  // Convert image to base64 &#8377; try local file first, then URL
async function imgToBase64(url, localPath) {
  let buf = null;

  // Try local file first
  if (localPath && fs.existsSync(localPath)) {
    try {
      buf = fs.readFileSync(localPath);
      console.log(`Image from local file: ${localPath} (${buf.length} bytes)`);
    } catch(e) { console.log('Local read failed:', e.message); }
  }

  // Fallback to URL
  if (!buf && url) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        buf = Buffer.from(await r.arrayBuffer());
        console.log(`Image from URL: ${url} (${buf.length} bytes)`);
      }
    } catch(e) { console.log('URL fetch error:', e.message); }
  }

  if (!buf) return null;

  // Compress using Cloudinary transformation URL if available
  if (url && url.includes('res.cloudinary.com') && url.includes('/upload/')) {
    try {
      const compressedUrl = url.replace('/upload/', '/upload/w_600,h_400,c_fill,q_60,f_jpg/');
      const r = await fetch(compressedUrl);
      if (r.ok) {
        const compBuf = Buffer.from(await r.arrayBuffer());
        console.log(`Compressed image: ${compBuf.length} bytes (was ${buf.length})`);
        return `data:image/jpeg;base64,${compBuf.toString('base64')}`;
      }
    } catch(e) { console.log('Compression fetch failed:', e.message); }
  }

  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

  // Pre-fetch all images as base64
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

 const projectCard = (p, idx) => {
  if (!p || !p.name) return `
    <div style="width:calc(50% - 12px);height:560px;background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;display:flex;flex-direction:column;">
      <div style="height:230px;background:linear-gradient(135deg,#1B5E20,#2E7D32);display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <div style="width:46px;height:46px;border-radius:50%;background:#F9A825;color:#1B5E20;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;margin-bottom:12px;">P</div>
        <div style="font-size:18px;font-weight:900;color:white;">Project ${idx + 1}</div>
      </div>
      <div style="padding:18px;flex:1;">
        <div style="font-size:13px;color:#4A6741;">No project data added</div>
      </div>
    </div>`;

  const imgStyle = p.photo_url
    ? `background-image:url('${p.photo_url}');background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#1B5E20,#2E7D32);`;

  return `
    <div style="width:calc(50% - 12px);height:560px;background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;display:flex;flex-direction:column;">
      <div style="height:230px;position:relative;${imgStyle}">
        <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.65),transparent);"></div>
        <div style="position:absolute;bottom:16px;left:16px;right:16px;color:white;">
          <div style="font-size:20px;font-weight:900;">${p.name || ''}</div>
          <div style="font-size:12px;margin-top:3px;opacity:0.9;">Location: ${p.city || ''}</div>
        </div>
      </div>

      <div style="padding:18px;flex:1;display:flex;flex-direction:column;">
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
          <span style="background:#F9A825;color:#1B5E20;font-size:11px;font-weight:900;padding:4px 12px;border-radius:20px;">${p.cap || p.capacity || '5 kW'} System</span>
          <span style="background:#F1F8E9;color:#2E7D32;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;border:1px solid #C8E6C9;">${p.roof || 'Flat RCC'}</span>
        </div>

        <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:6px;">Generation: ${p.kwh || '7,500 kWh/year'} estimated</div>
        <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:6px;">Installed: ${p.date || '2025'}</div>
        <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:10px;">Rating: ${p.rating || '4.9/5'}</div>

        ${p.quote ? `
          <div style="margin-top:auto;border-top:1px solid #C8E6C9;padding-top:10px;">
            <div style="font-size:11px;color:#4A6741;font-style:italic;line-height:1.45;">"${p.quote}"</div>
            <div style="font-size:10px;color:#2E7D32;font-weight:900;margin-top:5px;">— ${p.quote_author || p.quoteAuthor || ''}</div>
          </div>` : ''}
      </div>
    </div>`;
};

  const sectionHeader = (subtitle, title) => `
    <div style="background:#1B5E20;padding:40px 48px;color:white;">
     <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">${subtitle}</div>
      <div style="font-size:32px;font-weight:900;">${title}</div>
    </div>`;

  const monthlyData = [
    {m:'Jan',v:450},{m:'Feb',v:520},{m:'Mar',v:650},{m:'Apr',v:720},
    {m:'May',v:750},{m:'Jun',v:750},{m:'Jul',v:600},{m:'Aug',v:550},
    {m:'Sep',v:580},{m:'Oct',v:620},{m:'Nov',v:500},{m:'Dec',v:450}
  ];
const unitRateForChart = fin.yearlyKwh > 0 ? fin.annualSaving / fin.yearlyKwh : 6;

const chartBars = monthlyData.map(d => {
  const saving = Math.round(d.v * unitRateForChart);
  const savingShort = saving >= 1000
    ? `&#8377;${(saving / 1000).toFixed(1)}k`
    : `&#8377;${saving}`;

  return `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;">
      <div style="font-size:8px;color:#1B5E20;font-weight:900;margin-bottom:1px;white-space:nowrap;">${savingShort}</div>
      <div style="font-size:7px;color:#4A6741;font-weight:700;margin-bottom:3px;white-space:nowrap;">${d.v} kWh</div>
      <div style="width:14px;height:${Math.round((d.v / 750) * 70)}px;background:linear-gradient(to top,#8BC34A,#1B5E20);border-radius:2px 2px 0 0;"></div>
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

<!-- PAGE 0: DARK INTRO -->
<div class="page" style="background:#1A2F1A;">
  <div style="position:absolute;inset:0;opacity:0.08;background-image:radial-gradient(#fff 1.5px,transparent 1.5px);background-size:16px 16px;"></div>
  <div style="position:relative;height:48%;width:100%;">
    <div style="position:absolute;top:0;left:0;width:45%;height:96px;background:#F9A825;clip-path:polygon(0 0,100% 0,0 100%);z-index:2;"></div>
    <div style="position:absolute;top:0;right:0;width:45%;height:128px;background:#2E7D32;clip-path:polygon(20% 0,100% 0,100% 100%,0 100%);z-index:2;display:flex;align-items:flex-start;justify-content:flex-end;padding:28px;">
      <div style="display:flex;align-items:center;gap:12px;color:white;">
        <div style="text-align:right;">
          <div style="font-weight:900;font-size:18px;">${installer.company_name || 'SURYA POWER'}</div>
          <div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;opacity:0.9;">Solutions</div>
        </div>
        <div style="width:40px;height:40px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;">&#8377;</div>
      </div>
    </div>
    <div style="position:absolute;top:80px;right:0;width:96px;height:100%;background:#F9A825;clip-path:polygon(100% 0,100% 100%,0 40%);z-index:0;"></div>
    <div style="position:absolute;inset:0;z-index:1;background:#1B5E20;border-radius:0 0 96px 0;overflow:hidden;">
      <img src="https://images.unsplash.com/photo-1509391366360-2e959784a276?auto=format&fit=crop&w=1200&q=80" style="width:100%;height:100%;object-fit:cover;object-position:bottom;" />
      <div style="position:absolute;inset:0;background:rgba(27,94,32,0.2);"></div>
    </div>
  </div>
  <div style="padding:24px 48px 48px;display:flex;flex-direction:column;flex:1;position:relative;z-index:1;">
    <div style="text-align:right;margin-top:16px;">
      <div style="font-size:58px;font-weight:900;font-style:italic;color:white;line-height:0.9;letter-spacing:-2px;">Sustainable</div>
      <div style="font-size:58px;font-weight:900;font-style:italic;color:#F9A825;line-height:0.9;letter-spacing:-2px;margin-top:8px;">Energy Future</div>
      <div style="color:#C8E6C9;font-size:13px;margin-top:20px;max-width:280px;margin-left:auto;line-height:1.6;">Invest in advanced solar technology, enhancing your property value while embracing sustainable living.</div>
    </div>
    <div style="margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:flex-end;">
      <div>
        <div style="color:white;font-weight:700;font-size:20px;margin-bottom:16px;">Contact Us:</div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="width:24px;height:24px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">&#8377;</div>
          <span style="color:white;font-weight:600;">${installer.phone || '+91 98765 43210'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
          <div style="width:24px;height:24px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">&#8377;</div>
          <span style="color:white;font-weight:600;">${installer.website || 'www.suryapower.com'}</span>
        </div>
        <div style="background:#F9A825;color:#1A2F1A;font-weight:900;text-transform:uppercase;letter-spacing:2px;font-size:12px;padding:10px 28px;display:inline-block;border-radius:4px;">Learn More</div>
      </div>
      <div style="text-align:right;">
        <div style="color:white;font-weight:700;font-size:20px;margin-bottom:16px;">Our Service &#8377;</div>
        ${['Energy Consultation','System Maintenance','Solar Panel Installation','Battery & Inverter Setup'].map(s => `
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:12px;">
            <span style="color:#C8E6C9;font-weight:600;font-size:13px;">${s}</span>
            <div style="width:20px;height:20px;background:#8BC34A;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:10px;flex-shrink:0;">&#8377;</div>
          </div>`).join('')}
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
        ${installer.logo_url ? `<img src="${installer.logo_url}" style="height:44px;width:44px;border-radius:50%;object-fit:cover;border:2px solid #8BC34A;" />` : `<span style="font-size:32px;">&#8377;</span>`}
        <div>
          <div style="font-weight:900;font-size:22px;line-height:1;">${installer.company_name || 'SURYA POWER'}</div>
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
      <div style="color:#F9A825;font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:13px;margin-bottom:12px;">&#8377; India's Trusted Rooftop Solar EPC</div>
      <div style="font-size:52px;font-weight:900;color:white;line-height:1.1;">CLEAN ENERGY<br/>PROPOSAL</div>
    </div>
    <div style="flex:1;width:100%;border:4px solid #8BC34A;border-radius:24px;overflow:hidden;position:relative;min-height:220px;">
      <img src="${aiImageSrc}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.3),transparent);"></div>
    </div>
    <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;">
      <div style="background:white;padding:20px 24px;border-radius:16px;border:1px solid #C8E6C9;flex:1;max-width:420px;">
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Prepared Exclusively For:</div>
        <div style="font-size:22px;font-weight:900;color:#1A2F1A;margin-bottom:4px;">${customer.name}</div>
        <div style="font-size:12px;color:#4A6741;margin-bottom:12px;">${customer.address || ''}</div>
        <div style="height:1px;background:#C8E6C9;margin-bottom:12px;"></div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">System Size: <span style="color:#F9A825;font-weight:900;font-size:18px;background:#1B5E20;padding:2px 12px;border-radius:6px;">${fin.systemKw} kW</span></div>
      </div>
      <div style="text-align:right;">
        <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;margin-bottom:12px;">
          <span style="font-size:16px;">&#8377;&#8377;</span>
          <span style="font-weight:700;color:#1B5E20;font-size:12px;">PM Surya Ghar: Muft Bijli Yojana</span>
          <span style="color:#8BC34A;">&#8377;</span>
        </div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">&#8377; ${installer.website || 'www.suryapower.com'}</div>
        <div style="font-size:13px;color:#4A6741;margin-top:4px;">&#8377; ${installer.phone || '98765 43210'}</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 2: WELCOME LETTER -->
<div class="page" style="background:#F1F8E9;padding:48px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid #1B5E20;padding-bottom:20px;margin-bottom:36px;">
    <div style="display:flex;align-items:center;gap:10px;color:#1B5E20;">
      ${installer.logo_url ? `<img src="${installer.logo_url}" style="height:36px;width:36px;border-radius:50%;object-fit:cover;" />` : `<span style="font-size:24px;">&#8377;</span>`}
      <div>
        <div style="font-weight:900;font-size:18px;">${installer.company_name || 'SURYA POWER'}</div>
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;">Solutions</div>
      </div>
    </div>
    <div style="text-align:right;font-size:12px;color:#4A6741;font-weight:600;">
      <div>${today}</div><div>Ref: ${proposalNo}</div>
    </div>
  </div>
  <div style="font-size:26px;font-weight:900;color:#1A2F1A;margin-bottom:24px;">Dear ${customer.name},</div>
  <div style="background:linear-gradient(to right,#FFF8E1,#F1F8E9);border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;gap:16px;margin-bottom:28px;">
    <div style="width:56px;height:56px;background:white;border-radius:50%;border:3px solid #F9A825;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;">&#8377;&#8377;</div>
    <div>
      <div style="font-size:18px;font-weight:900;color:#1B5E20;">PM Surya Ghar: Muft Bijli Yojana</div>
      <div style="font-size:12px;font-weight:700;color:#2E7D32;margin-top:2px;">Empanelled & Authorized Vendor</div>
    </div>
    <div style="margin-left:auto;background:linear-gradient(to right,#F9A825,#FF8F00);color:white;font-weight:900;padding:8px 16px;border-radius:10px;font-size:12px;">SUBSIDY READY</div>
  </div>
  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">Welcome to <strong style="color:#1B5E20;">${installer.company_name || 'Surya Power Solutions'}</strong>! We are excited to present your customised <strong>${fin.systemKw} kW solar system</strong>. As an authorised PM Surya Ghar partner with over ${installer.years || '8'}+ years of excellence, we ensure a seamless transition to clean, affordable energy.</div>
  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">This proposal outlines your exact system specifications, financial savings, and the straightforward roadmap to claiming your <strong style="color:#1B5E20;">&#8377;.subsidyAmount.toLocaleString('en-IN')}</strong> government subsidy.</div>
  <div style="font-size:15px;color:#4A6741;line-height:1.8;">Please review the detailed projections inside. Our technical team is ready to answer any questions.</div>
  <div style="margin-top:32px;color:#1B5E20;font-weight:700;">Warm Regards,</div>
  <div style="font-family:Georgia,serif;font-size:36px;color:#2E7D32;opacity:0.9;margin-top:8px;">${installer.company_name || 'Surya Power'}</div>
  <div style="font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
  <div style="font-size:12px;color:#8BC34A;font-weight:700;">${installer.email || ''}</div>
  <div style="margin-top:auto;padding-top:28px;display:flex;justify-content:center;">
    <div style="background:white;border:1px solid #C8E6C9;border-radius:16px;padding:16px 28px;text-align:center;">
      <div style="font-size:11px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Authorized & Empanelled</div>
      <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;">
        <span>&#8377;&#8377;</span><span style="font-weight:700;color:#1B5E20;font-size:13px;">PM Surya Ghar: Muft Bijli Yojana</span><span style="color:#8BC34A;">&#8377;</span>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 3: PROJECTS 1 -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="background:white;border:2px solid #C8E6C9;border-radius:16px;display:flex;justify-content:space-between;align-items:center;padding:14px 24px;margin-bottom:28px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;width:100%;height:4px;background:linear-gradient(to right,#F9A825,#8BC34A);"></div>
     ${[
  {label:'In Business',   value: installer.years || '8+', icon:'Y'},
  {label:'Installations', value: installer.installations || '450+', icon:'I'},
  {label:'Capacity',      value: installer.total_kw || '2.1 MW', icon:'C'},
  {label:'Rating',        value: installer.rating || '4.9/5', icon:'R'},
].map((s,i) => `
  <div style="display:flex;align-items:center;gap:12px;">
    <div style="width:44px;height:44px;background:#E8F5E9;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#1B5E20;">${s.icon}</div>
    <div>
      <div style="font-size:18px;font-weight:900;color:#1B5E20;">${s.value}</div>
      <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${s.label}</div>
    </div>
  </div>
  ${i<3?'<div style="width:1px;height:40px;background:#C8E6C9;"></div>':''}`).join('')}
    </div>
    <div style="display:flex;gap:24px;flex:1;">
      ${projectCard(projects[0],0)}
      ${projectCard(projects[1],1)}
    </div>
  </div>
</div>

<!-- PAGE 4: PROJECTS 2 -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;">
      ${projectCard(projects[2],2)}
      ${projectCard(projects[3],3)}
    </div>
  </div>
</div>

<!-- PAGE 5: PROJECTS 3 + COMMITMENTS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;margin-bottom:24px;">
      ${projectCard(projects[4],4)}
      ${projectCard(projects[5],5)}
    </div>
    <div style="background:#1B5E20;color:white;border-radius:16px;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
  ${[
  {icon:'M', label:'MNRE Empanelled', sub:'Installer'},
  {icon:'T', label:'Tier-1 Brands Only', sub:'Waaree, Adani, Vikram'},
  {icon:'A', label:'5 Year Free AMC', sub:'Included'},
].map((c,i)=>`
        <div style="display:flex;align-items:center;gap:12px;flex:1;justify-content:center;">
          <div style="background:#8BC34A;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#1B5E20;font-weight:900;font-size:16px;">${c.icon}</div>
          <div style="text-align:center;">
            <div style="font-weight:700;font-size:13px;">${c.label}</div>
            <div style="font-size:10px;opacity:0.8;">${c.sub}</div>
          </div>
        </div>
        ${i<2?'<div style="width:1px;height:40px;background:rgba(255,255,255,0.2);"></div>':''}`).join('')}
    </div>
  </div>
</div>

<!-- PAGE 6: SYSTEM DESIGN -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Technical Overview', 'Proposed System Design')}
  <div style="padding:28px 48px;">
    <div style="width:100%;height:340px;border-radius:20px;overflow:hidden;border:2px solid #C8E6C9;margin-bottom:24px;position:relative;">
      <img src="${aiImageSrc}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.4),transparent);"></div>
      <div style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:white;font-weight:700;font-size:13px;background:rgba(0,0,0,0.5);padding:6px 16px;border-radius:20px;">AI Generated &#8377; Your Actual Roof View</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
     ${[
  {title:'System Size',  value:`${fin.systemKw} kW`, icon:'P'},
  {title:'Solar Panels', value:`${panelCount}x ${panelBrand.split(' ')[0]} 550W`, icon:'S'},
  {title:'Orientation',  value:'South / 25 deg Tilt', icon:'O'},
  {title:'Connection',   value:'On-Grid Net Meter', icon:'G'},
].map(s=>`
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
         <div style="width:28px;height:28px;border-radius:50%;background:#E8F5E9;color:#1B5E20;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;margin-bottom:8px;">${s.icon}</div>
          <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${s.title}</div>
          <div style="font-size:14px;font-weight:900;color:#1A2F1A;">${s.value}</div>
        </div>`).join('')}
    </div>
    <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="background:linear-gradient(135deg,#8BC34A,#2E7D32);padding:14px;border-radius:50%;font-size:24px;">&#8377;</div>
        <div>
          <div style="font-size:17px;font-weight:900;color:#1B5E20;">Environmental Impact</div>
          <div style="font-size:13px;font-weight:700;color:#4A6741;">Offsets ${fin.co2} Tonnes of CO2 emissions annually</div>
        </div>
      </div>
      <div style="background:#F1F8E9;padding:12px 16px;border-radius:12px;border:1px solid #C8E6C9;text-align:right;">
        <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;">Equivalent to planting</div>
        <div style="font-size:26px;font-weight:900;color:#1B5E20;">${fin.trees} Trees / Year</div>
      </div>
    </div>
    <div style="background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;">
      <div style="background:#1B5E20;padding:12px 20px;color:white;font-weight:700;font-size:14px;">&#8377; Detailed Specifications</div>
      ${[
        ['System Type',           'Grid-Tied (On-Grid) Rooftop Solar PV System'],
        ['Panel Model',           `${panelBrand} 550W Monocrystalline PERC Half-Cut`],
        ['Inverter Model',        `${inverterBrand} ${fin.systemKw}kW String Inverter (Wi-Fi Enabled)`],
        ['Mounting Structure',    'Hot-Dip Galvanized (HDG) MS, 25 deg Optimal Tilt'],
        ['Estimated Annual Gen.', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh (Units) per year`],
      ].map((r,i)=>`
        <div style="display:flex;border-bottom:1px solid #C8E6C9;background:${i%2===0?'#F1F8E9':'white'};">
          <div style="padding:12px 20px;width:40%;font-size:12px;font-weight:700;color:#4A6741;">${r[0]}</div>
          <div style="padding:12px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[1]}</div>
        </div>`).join('')}
    </div>
  </div>
</div>

<!-- PAGE 7: FINANCIAL SAVINGS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Return on Investment', 'Financial Savings Analysis')}
  <div style="padding:28px 48px;">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:24px;">
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;">Total System Cost</div>
        <div style="font-size:20px;font-weight:900;color:#1A2F1A;margin-top:6px;">&#8377;.quotedPrice.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#E8F5E9;border:2px solid #8BC34A;border-radius:12px;padding:16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;right:0;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:3px 8px;border-radius:0 0 0 8px;">APPROVED</div>
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">PM Surya Ghar Subsidy</div>
        <div style="font-size:20px;font-weight:900;color:#2E7D32;margin-top:6px;">&#8377;.subsidyAmount.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#1B5E20;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#8BC34A;text-transform:uppercase;letter-spacing:1px;">Your Net Investment</div>
        <div style="font-size:24px;font-weight:900;color:white;margin-top:6px;">&#8377;.netCost.toLocaleString('en-IN')}</div>
      </div>
      <div style="background:#F1F8E9;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">Payback Period</div>
        <div style="font-size:20px;font-weight:900;color:#1B5E20;margin-top:6px;">${fin.payback} Years</div>
      </div>
    </div>
    <div style="display:flex;gap:24px;">
      <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:16px;overflow:hidden;">
        <div style="background:#E8F5E9;padding:14px 20px;border-bottom:2px solid #C8E6C9;">
          <div style="font-weight:900;color:#1B5E20;font-size:14px;">&#8377; Savings Projections</div>
        </div>
        ${[
          ['Annual Generation',   `${fin.yearlyKwh.toLocaleString('en-IN')} kWh`,             '#1A2F1A'],
          ['Current Monthly Bill',`&#8377;.monthlyBefore.toLocaleString('en-IN')}`,            '#1A2F1A'],
          ['Monthly Savings',     `&#8377{Math.round(fin.annualSaving/12).toLocaleString('en-IN')}`,'#2E7D32'],
          ['Annual Savings',      `&#8377;.annualSaving.toLocaleString('en-IN')}`,             '#2E7D32'],
          ['10 Year Savings',     `&#8377{(fin.annualSaving*10).toLocaleString('en-IN')}`,        '#1A2F1A'],
          ['25 Year Savings',     `&#8377{(fin.annualSaving*25).toLocaleString('en-IN')}`,        '#1A2F1A'],
          ['25 Year Net Profit',  `&#8377;.saving25yr.toLocaleString('en-IN')}`,               '#F9A825'],
        ].map(r=>`
          <div style="display:flex;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #C8E6C9;">
            <span style="font-size:12px;color:#4A6741;font-weight:600;">${r[0]}</span>
            <span style="font-size:12px;font-weight:900;color:${r[2]};">${r[1]}</span>
          </div>`).join('')}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;gap:12px;">
          <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:6px;">Before Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1A2F1A;">&#8377;.monthlyBefore.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#4A6741;margin-top:4px;">per month</div>
          </div>
          <div style="flex:1;background:#F1F8E9;border:2px solid #8BC34A;border-radius:12px;padding:14px;text-align:center;position:relative;overflow:hidden;">
            <div style="position:absolute;top:-4px;right:-16px;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:4px 24px;transform:rotate(45deg);">SAVE ${fin.savePct}%</div>
            <div style="font-size:10px;color:#2E7D32;font-weight:700;text-transform:uppercase;margin-bottom:6px;">After Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1B5E20;">&#8377;.monthlyAfter.toLocaleString('en-IN')}</div>
            <div style="font-size:10px;color:#2E7D32;margin-top:4px;">per month</div>
          </div>
        </div>
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;flex:1;">
         <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Monthly Generation & Savings</div>
<div style="display:flex;align-items:flex-end;gap:2px;height:120px;border-bottom:2px solid #E8F5E9;padding-bottom:4px;">
            ${chartBars}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 8: BILL OF MATERIALS -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Technical Delivery', 'Bill of Materials (BOM)')}
  <div style="padding:28px 48px;">
    <div style="background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;margin-bottom:20px;">
      <table>
        <thead>
          <tr style="background:#1B5E20;color:white;">
            <th style="padding:14px 20px;text-align:left;font-size:11px;text-transform:uppercase;width:22%;">Component</th>
            <th style="padding:14px 20px;text-align:left;font-size:11px;text-transform:uppercase;width:44%;">Brand & Specification</th>
            <th style="padding:14px 20px;text-align:center;font-size:11px;text-transform:uppercase;width:10%;">Qty</th>
            <th style="padding:14px 20px;text-align:left;font-size:11px;text-transform:uppercase;width:24%;">Warranty</th>
          </tr>
        </thead>
        <tbody>
          ${[
            [panelBrand,    `${panelBrand} 550W Mono PERC Half Cut`,                `${panelCount} Nos`, '25yr Performance / 10yr Product'],
            ['Inverter',    `${inverterBrand} ${fin.systemKw}kW Wi-Fi String Inverter IP65`, '1 No',    '10 Years'],
            ['Structure',   'GI/MS Hot Dip Galvanized 25 MNRE Approved',           '1 Set',             '10 Years'],
            ['DC Cables',   '4mm UV Resistant with MC4 Connectors',                 'As Req.',           '10 Years'],
            ['AC DB Box',   'IP65 Enclosure with SPD, MCB, Isolator',               '1 No',              '2 Years'],
            ['Earthing & LA','Maintenance-free GI Plate & Lightning Arrester',      '1 Set',             '5 Years'],
            ['Net Meter',   'Bidirectional DISCOM Approved Meter',                  '1 No',              'Per DISCOM'],
          ].map((r,i)=>`
            <tr style="border-bottom:1px solid #C8E6C9;background:${i%2===0?'white':'#F1F8E9'};">
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#1B5E20;text-align:center;background:#E8F5E9;">${r[2]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#2E7D32;">${r[3]}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;gap:16px;">
      <div style="background:#E8F5E9;padding:10px;border-radius:50%;font-size:20px;flex-shrink:0;align-self:flex-start;">&#8377;</div>
      <div>
        <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:6px;">Balance of System (BOS) Inclusion Note:</div>
        <div style="font-size:12px;color:#4A6741;font-weight:600;line-height:1.6;">All necessary civil work for foundation blocks, PVC conduits, junction boxes, cable trays, and minor hardware required for a safe, code-compliant installation are fully included in the system cost.</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 9: PRICING & PAYMENT -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Commercials', 'Pricing & Payment Terms')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;gap:22px;">
    <div style="background:white;border:4px solid #1B5E20;border-radius:16px;padding:28px;position:relative;margin-top:12px;">
      <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);background:#1B5E20;color:white;padding:6px 20px;border-radius:20px;font-weight:700;font-size:12px;letter-spacing:2px;text-transform:uppercase;white-space:nowrap;">&#8377; Final Quotation</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-top:8px;">
        <span style="font-size:17px;font-weight:700;color:#4A6741;">Total System Cost</span>
        <span style="font-size:20px;font-weight:900;color:#1A2F1A;">&#8377; ${fin.quotedPrice.toLocaleString('en-IN')}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:20px;border-bottom:2px dashed #C8E6C9;color:#2E7D32;">
        <span style="font-size:15px;font-weight:700;">Less: PM Surya Ghar Subsidy</span>
        <span style="font-size:17px;font-weight:900;">- &#8377; ${fin.subsidyAmount.toLocaleString('en-IN')}</span>
      </div>
      <div style="background:#F1F8E9;padding:20px 24px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;border:1px solid #C8E6C9;">
        <div>
          <div style="font-size:11px;font-weight:900;color:#1B5E20;text-transform:uppercase;letter-spacing:2px;">Net Amount Payable</div>
          <div style="font-size:10px;color:#4A6741;margin-top:2px;">*Excluding GST as applicable</div>
        </div>
        <div style="font-size:44px;font-weight:900;color:#1B5E20;">&#8377; ${fin.netCost.toLocaleString('en-IN')}</div>
      </div>
    </div>
    <div>
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:12px;">&#8377; Payment Milestones</div>
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;overflow:hidden;">
        <table>
          <thead><tr style="background:#E8F5E9;color:#2E7D32;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">
            <th style="padding:12px 20px;text-align:left;">Milestone</th>
            <th style="padding:12px 20px;text-align:left;">Timeline</th>
            <th style="padding:12px 20px;text-align:right;">Amount</th>
          </tr></thead>
          <tbody>
            ${[
              ['20% Advance',          'On Proposal Signing (Due Today)',      `&#8377; ${fin.advance.toLocaleString('en-IN')}`],
              ['70% Material Readiness','Before Material Delivery (Day 3-5)',  `&#8377; ${fin.material.toLocaleString('en-IN')}`],
              ['10% Commissioning',    'After Meter Install & Testing',        `&#8377; ${fin.final.toLocaleString('en-IN')}`],
            ].map((r,i)=>`
              <tr style="border-top:1px solid #C8E6C9;background:${i%2===1?'#F1F8E9':'white'};">
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${r[0]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:700;color:#4A6741;">${r[1]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;text-align:right;">${r[2]}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#1B5E20;color:white;padding:20px;border-radius:16px;">
        <div style="font-size:11px;font-weight:900;color:#F9A825;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.2);">&#8377; Bank Details</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Bank:</span>${installer.bank_name || 'HDFC Bank'}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Account:</span>${installer.account_no || 'XXXX XXXX XXXX'}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">IFSC:</span>${installer.ifsc || 'HDFC0001234'}</div>
        <div style="font-size:12px;font-weight:900;color:#F9A825;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.2);">&#8377; UPI: ${installer.upi || 'contact@suryapower.com'}</div>
      </div>
      <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:20px;">
        <div style="font-size:14px;font-weight:900;color:#1B5E20;margin-bottom:10px;">&#8377; Important Note</div>
        <div style="font-size:12px;color:#4A6741;line-height:1.7;">GST at prevailing rates will be charged extra. The PM Surya Ghar subsidy of &#8377;.subsidyAmount.toLocaleString('en-IN')} will be credited <strong style="color:#1B5E20;">directly to your linked bank account</strong> by the government. &#8377;</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 10: NEXT STEPS + FOOTER -->
<div class="page" style="background:#F1F8E9;padding:48px;display:flex;flex-direction:column;">
  <div style="margin-bottom:36px;">
    <div style="font-size:28px;font-weight:900;color:#1B5E20;text-align:center;margin-bottom:32px;">&#8377; Your Journey to Clean Energy</div>
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
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px;">
    <div style="background:white;padding:24px;border-radius:16px;border:2px solid #C8E6C9;border-top:8px solid #8BC34A;">
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:16px;">&#8377; Scope Included</div>
      ${['All Solar Materials & Components','End-to-End Installation & Wiring','Custom Mounting Structure','Subsidy Documentation & Portal Entry','Net Meter Application Process','1 Year Free Workmanship Warranty'].map(s=>`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#8BC34A;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>`).join('')}
    </div>
    <div style="background:white;padding:24px;border-radius:16px;border:2px solid #C8E6C9;border-top:8px solid #4A6741;">
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:16px;">&#8377; Scope Excluded</div>
      ${['Official DISCOM / Utility Fees','Major Pre-existing Electrical Upgrades','Major Civil Roof Repairs before installation','Water arrangement for panel cleaning'].map(s=>`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#4A6741;opacity:0.5;flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:#4A6741;">${s}</span>
        </div>`).join('')}
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;padding:0 32px;margin-bottom:32px;">
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${customer.name}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Customer Acceptance & Date</div>
    </div>
    <div style="width:35%;border-top:2px solid #1B5E20;padding-top:12px;text-align:center;">
      <div style="font-size:15px;font-weight:900;color:#1A2F1A;">${installer.company_name || 'Surya Power Solutions'}</div>
      <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Authorised Signatory &#8377; ${today}</div>
    </div>
  </div>
  <div style="background:#1B5E20;margin:-48px;margin-top:auto;padding:40px 48px;color:white;">
    <div style="font-size:32px;font-weight:900;text-align:center;margin-bottom:8px;">Thank You for Choosing Clean Energy</div>
    <div style="text-align:center;color:#8BC34A;font-weight:700;font-size:15px;margin-bottom:24px;">&#8377; Together we are building a sustainable India.</div>
    <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(139,195,74,0.3);border-bottom:1px solid rgba(139,195,74,0.3);padding:16px 0;margin-bottom:16px;">
      <span>Tel: ${installer.phone || '98765 43210'}</span>
<span>Email: ${installer.email || 'info@suryapower.com'}</span>
<span>Web: ${installer.website || 'www.suryapower.com'}</span>
    </div>
  <div style="text-align:center;font-size:11px;color:#C8E6C9;font-weight:600;letter-spacing:0.5px;">
      ${installer.company_name || 'Surya Power Solutions'} &#8377; GST: ${installer.gst || 'XXXXXXXXXXXX'} &#8377; Powered by SolarQuote
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

// &#8377;&#8377; SERVE &#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;&#8377;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`solarscan running on port ${PORT}`);
});
