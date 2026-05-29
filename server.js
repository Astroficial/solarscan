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
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'static')));

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
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

// ---------------------------- HELPERS ----------------------------------------

function getPanelLayout(count) {
  if (count <= 12) return { rows: 2, cols: Math.ceil(count / 2) };
  if (count <= 21) return { rows: 3, cols: Math.ceil(count / 3) };
  return { rows: 4, cols: Math.ceil(count / 4) };
}

function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;

  const clean = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .trim();

  return clean || fallback;
}

function money(value) {
  const n = Number(value || 0);
  return `&#8377;${n.toLocaleString('en-IN')}`;
}

function defaultInstaller() {
  return {
    company_name: 'Solar Installer',
    phone: '',
    email: '',
    website: '',
    address: '',
    gst: '',
    years: '5+',
    installations: '450+',
    total_kw: '2.1 MW',
    rating: '4.9/5',
    bank_name: '',
    account_no: '',
    ifsc: '',
    upi: '',
    logo_url: '',
    projects: [],
  };
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
    `The camera was pointing NORTH. Therefore all solar panels must face TRUE SOUTH, directly toward the camera. The full front glass surface of all panels must be visible. ` +
    `Preserve the original roof photo completely. Do not change roof geometry, parapet walls, vents, tanks, AC units, pipes, trees, towers, buildings, sky, or background. ` +
    `Add realistic shadows under panels, support rods, frames, and RCC blocks matching the original sunlight direction. ` +
    `Strict negative instructions: do not create one continuous solar sheet. Do not merge panels. Do not change panel count. Do not create floating panels. Do not distort roof or background.`
  );
}

function estimateSubsidy(systemKw, customerType) {
  if (customerType !== 'residential') return 0;

  if (systemKw >= 3) return 78000;
  if (systemKw >= 2) return 60000;
  if (systemKw >= 1) return 30000;

  return 0;
}

function calculateSiteCost(systemKw, panelBrand, inverterBrand, site) {
  const panelRateByBrand = {
    'Waaree Solar': 22,
    'Adani Solar': 23,
    'Vikram Solar': 22,
    'Tata Power Solar': 24,
    'Renewsys Solar': 21,
  };

  const inverterBaseByBrand = {
    Solis: 35000,
    Growatt: 32000,
    Havells: 38000,
    SolarEdge: 65000,
    Fronius: 70000,
  };

  const panelRate = panelRateByBrand[panelBrand] || 22;
  const inverterBase = inverterBaseByBrand[inverterBrand] || 35000;

  const cableDistance = Number(site.cableDistance || 30);
  const structureHeight = Number(site.structureHeight || 3);

  const mountingType = site.mountingType || 'normal';
  const rooftopAccess = site.rooftopAccess || 'easy';

  const structureRateByType = {
    normal: 8000,
    elevated: 14000,
    shed: 6500,
    custom: 16000,
  };

  const accessMultiplier = {
    easy: 1,
    medium: 1.15,
    difficult: 1.35,
  };

  const structureRate = structureRateByType[mountingType] || 8000;
  const labourMultiplier = accessMultiplier[rooftopAccess] || 1;

  const heightExtra = Math.max(0, structureHeight - 3) * systemKw * 1500;

  const panelCost = Math.round(systemKw * 1000 * panelRate);
  const inverterCost = Math.round(inverterBase + Math.max(0, systemKw - 5) * 5000);
  const structureCost = Math.round(systemKw * structureRate + heightExtra);
  const cableCost = Math.round(cableDistance * 120);
  const labourCost = Math.round(systemKw * 5000 * labourMultiplier);

  const acDcBoxCost = 9000;
  const earthingLaCost = 9000;
  const netMeteringCost = site.phaseType === 'three' ? 10000 : 7000;
  const transportCost = 5000;
  const miscCost = 8000;

  const baseCost =
    panelCost +
    inverterCost +
    structureCost +
    cableCost +
    labourCost +
    acDcBoxCost +
    earthingLaCost +
    netMeteringCost +
    transportCost +
    miscCost;

  const gstRate = 0.12;
  const gstAmount = Math.round(baseCost * gstRate);

  const installerCost = baseCost + gstAmount;

  const marginRate = 0.25;
  const suggestedQuote = Math.ceil((installerCost * (1 + marginRate)) / 1000) * 1000;

  return {
    panelCost,
    inverterCost,
    structureCost,
    cableCost,
    labourCost,
    acDcBoxCost,
    earthingLaCost,
    netMeteringCost,
    transportCost,
    miscCost,
    gstAmount,
    installerCost,
    suggestedQuote,
  };
}

function calcFinancials(
  systemKw,
  monthlyBill,
  quotedPriceInput,
  subsidyAmountInput,
  site = {},
  panelBrand = 'Waaree Solar',
  inverterBrand = 'Solis'
) {
  const siteCost = calculateSiteCost(systemKw, panelBrand, inverterBrand, site);

  const quotedPrice = Number(quotedPriceInput || 0) > 0
    ? Number(quotedPriceInput)
    : siteCost.suggestedQuote;

  const subsidyAmount = Number(subsidyAmountInput || 0) > 0
    ? Number(subsidyAmountInput)
    : estimateSubsidy(systemKw, site.customerType || 'residential');

  const netCost = Math.max(0, quotedPrice - subsidyAmount);

  const shadingLossByType = {
    none: 0,
    low: 0.05,
    medium: 0.12,
    high: 0.22,
  };

  const shadingLoss = shadingLossByType[site.shading || 'none'] || 0;

  const yearlyKwh = Math.round(systemKw * 1500 * (1 - shadingLoss));

  const monthlyUnits = Number(site.monthlyUnits || 0);

  const unitRate = monthlyUnits > 0
    ? Math.max(5, Math.min(monthlyBill / monthlyUnits, 15))
    : Math.max(6, Math.min((monthlyBill * 12) / Math.max(yearlyKwh, 1), 12));

  const annualSaving = Math.round(yearlyKwh * unitRate);
  const payback = (netCost / Math.max(annualSaving, 1)).toFixed(1);
  const saving25yr = Math.round((annualSaving * 25) - netCost);

  const monthlyAfter = Math.max(0, Math.round(monthlyBill - annualSaving / 12));

  const savePct = monthlyBill > 0
    ? Math.round(((monthlyBill - monthlyAfter) / monthlyBill) * 100)
    : 0;

  const co2 = ((yearlyKwh * 0.82) / 1000).toFixed(1);
  const trees = Math.round(yearlyKwh * 0.82 / 1000 * 24);

  const estimatedMargin = quotedPrice - siteCost.installerCost;
  const estimatedMarginPct = quotedPrice > 0
    ? Math.round((estimatedMargin / quotedPrice) * 100)
    : 0;

  return {
    systemKw,
    quotedPrice,
    suggestedQuote: siteCost.suggestedQuote,
    subsidyAmount,
    netCost,

    installerCost: siteCost.installerCost,
    estimatedMargin,
    estimatedMarginPct,
    costBreakup: siteCost,

    yearlyKwh,
    annualSaving,
    payback,
    saving25yr,
    monthlyBefore: monthlyBill,
    monthlyAfter,
    savePct,
    co2,
    trees,

    site,

    advance: Math.round(netCost * 0.20),
    material: Math.round(netCost * 0.70),
    final: Math.round(netCost * 0.10),
  };
}
  // ---------------------------- CLOUDINARY UPLOAD -------------------------------

async function uploadToCloudinary(buffer, folder, publicId, resourceType = 'image') {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

  const isProfile = publicId.includes('profile');

  const fileName = resourceType === 'raw'
    ? (isProfile ? `${publicId}.json` : `${publicId}.pdf`)
    : `${publicId}.jpg`;

  const fileType = resourceType === 'raw'
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
    throw new Error(`Cloudinary non-JSON response: ${responseText.slice(0, 200)}`);
  }

  if (!response.ok || data.error) {
    throw new Error('Cloudinary: ' + (data.error?.message || responseText));
  }

  if (!data.secure_url) {
    throw new Error('Cloudinary: secure_url missing');
  }

  console.log(`Cloudinary upload OK: ${data.public_id}`);
  return data.secure_url;
}

// ---------------------------- SAVE PROFILE ------------------------------------

app.post('/api/save-profile', upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'project0', maxCount: 1 },
  { name: 'project1', maxCount: 1 },
  { name: 'project2', maxCount: 1 },
  { name: 'project3', maxCount: 1 },
  { name: 'project4', maxCount: 1 },
  { name: 'project5', maxCount: 1 },
]), async (req, res) => {
  try {
    const installerId = req.body.installer_id || 'default';
    const profile = JSON.parse(req.body.profile_json || '{}');

    if (req.files?.logo?.[0]) {
      profile.logo_url = await uploadToCloudinary(
        req.files.logo[0].buffer,
        `solarscan/${installerId}`,
        'logo',
        'image'
      );
    }

    profile.projects = profile.projects || [];

    for (let i = 0; i < 6; i++) {
      const key = `project${i}`;
      const meta = profile.projects[i] || {};

      if (req.files?.[key]?.[0]) {
        const buf = req.files[key][0].buffer;

        meta.photo_url = await uploadToCloudinary(
          buf,
          `solarscan/${installerId}/projects`,
          `project_${i}`,
          'image'
        );

        const localPath = path.join(TMP, `${installerId}_project_${i}.jpg`);
        fs.writeFileSync(localPath, buf);
        meta.local_path = localPath;
      }

      profile.projects[i] = meta;
    }

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    const profileBuf = Buffer.from(JSON.stringify(profile, null, 2));

    await uploadToCloudinary(
      profileBuf,
      `solarscan/${installerId}`,
      'profile',
      'raw'
    );

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ---------------------------- LOAD PROFILE ------------------------------------

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
      const response = await fetch(url);

      if (response.ok) {
        const profile = await response.json();
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
        console.log('Profile restored from Cloudinary');
        return res.json({ success: true, profile });
      }

      console.log('Cloudinary profile fetch status:', response.status);
    } catch (err) {
      console.log('Cloudinary profile fetch error:', err.message);
    }

    res.json({ success: true, profile: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------- GENERATE QUOTE ----------------------------------

app.post('/api/generate-quote', upload.single('photo'), async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  try {
    if (!req.file?.buffer) {
      throw new Error('No roof photo uploaded');
    }

    const systemKw = parseFloat(req.body.system_kw || 5);
    const panelWatt = parseInt(req.body.panel_watt || 550);
    const panelCount = Math.ceil((systemKw * 1000) / panelWatt);
   const quotedPrice = parseInt(req.body.quoted_price || 0);
const subsidyAmount = parseInt(req.body.subsidy_amount || 0);
const monthlyBill = parseInt(req.body.monthly_bill || 3000);

const roofType = req.body.roof_type || 'flat_rcc';
const panelBrand = req.body.panel_brand || 'Waaree Solar';
const inverterBrand = req.body.inverter_brand || 'Solis';
const installerId = req.body.installer_id || 'default';

const site = {
  customerType: req.body.customer_type || 'residential',
  cityDiscom: req.body.city_discom || 'other',
  monthlyUnits: parseInt(req.body.monthly_units || 0),
  sanctionedLoad: parseFloat(req.body.sanctioned_load || 0),
  cableDistance: parseFloat(req.body.cable_distance || 30),
  phaseType: req.body.phase_type || 'single',
  mountingType: req.body.mounting_type || 'normal',
  structureHeight: parseFloat(req.body.structure_height || 3),
  shading: req.body.shading || 'none',
  rooftopAccess: req.body.rooftop_access || 'easy',
  roofType,
};

    let legHeights = [3];

    try {
      legHeights = JSON.parse(req.body.leg_heights_ft || '[3]');
      if (!Array.isArray(legHeights)) legHeights = [3];
    } catch {
      legHeights = [3];
    }

    const customer = {
      name: req.body.customer_name || 'Homeowner',
      phone: req.body.customer_phone || '',
      address: req.body.customer_address || '',
    };

    let installer = null;
    const profilePath = path.join(TMP, `profile_${installerId}.json`);

    if (fs.existsSync(profilePath)) {
      installer = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      console.log(`Profile loaded from /tmp. Projects: ${installer.projects?.length || 0}`);
    } else {
      console.log('Profile not in /tmp, fetching from Cloudinary...');

      const url = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/raw/upload/solarscan/${installerId}/profile`;

      try {
        const response = await fetch(url);

        if (response.ok) {
          installer = await response.json();
          fs.writeFileSync(profilePath, JSON.stringify(installer, null, 2));
          console.log(`Profile restored. Projects: ${installer.projects?.length || 0}`);
        } else {
          console.log('Cloudinary profile fetch status:', response.status);
        }
      } catch (err) {
        console.log('Cloudinary profile fetch error:', err.message);
      }
    }

    if (!installer) {
      installer = defaultInstaller();
    }

    if (installer.projects) {
      for (let i = 0; i < installer.projects.length; i++) {
        const project = installer.projects[i];

        if (project?.photo_url && (!project.local_path || !fs.existsSync(project.local_path))) {
          try {
            const response = await fetch(project.photo_url);

            if (response.ok) {
              const buf = Buffer.from(await response.arrayBuffer());
              const localPath = path.join(TMP, `${installerId}_project_${i}.jpg`);
              fs.writeFileSync(localPath, buf);
              project.local_path = localPath;
              console.log(`Restored project ${i} photo from Cloudinary (${buf.length} bytes)`);
            }
          } catch (err) {
            console.log(`Could not restore project ${i} photo:`, err.message);
          }
        }
      }
    }

    const photoPath = path.join(jobDir, 'roof_marked.jpg');
    fs.writeFileSync(photoPath, req.file.buffer);

    console.log(`Photo: ${req.file.buffer.length} bytes`);
    console.log(`Job ${jobId}: Generating AI image...`);

    const prompt = buildPrompt(systemKw, panelCount, legHeights, roofType);

    const { toFile } = await import('openai');
    const imageFile = await toFile(
      fs.createReadStream(photoPath),
      'roof_marked.jpg',
      { type: 'image/jpeg' }
    );

    const aiResult = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
    });

    if (!aiResult.data?.[0]?.b64_json) {
      throw new Error('OpenAI returned empty image data');
    }

    const imageBuffer = Buffer.from(aiResult.data[0].b64_json, 'base64');
    fs.writeFileSync(path.join(jobDir, 'result.jpg'), imageBuffer);

    console.log(`Job ${jobId}: Uploading AI image...`);

    const aiImageUrl = await uploadToCloudinary(
      imageBuffer,
      'solarscan/results',
      `result_${jobId}`,
      'image'
    );

const fin = calcFinancials(
  systemKw,
  monthlyBill,
  quotedPrice,
  subsidyAmount,
  site,
  panelBrand,
  inverterBrand
);

    console.log(`Job ${jobId}: Generating PDF...`);

    const pdfPath = path.join(jobDir, 'proposal.pdf');

    const pdfBuffer = await generatePDF({
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

    console.log(`PDF size: ${pdfBuffer.length} bytes`);

    if (!pdfBuffer || pdfBuffer.length < 1000) {
      throw new Error(`PDF too small: ${pdfBuffer?.length || 0} bytes`);
    }

    console.log(`Job ${jobId}: Uploading PDF...`);

    const pdfUrl = await uploadToCloudinary(
      pdfBuffer,
      'solarscan/pdfs',
      `proposal_${jobId}`,
      'raw'
    );

    res.json({
      success: true,
      job_id: jobId,
      image_url: aiImageUrl,
      pdf_url: pdfUrl,
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

// ---------------------------- PDF GENERATION ----------------------------------

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
  async function imgToBase64(url, localPath) {
    let buf = null;

    if (localPath && fs.existsSync(localPath)) {
      try {
        buf = fs.readFileSync(localPath);
        console.log(`Image from local file: ${localPath} (${buf.length} bytes)`);
      } catch (err) {
        console.log('Local read failed:', err.message);
      }
    }

    if (!buf && url) {
      try {
        const response = await fetch(url);

        if (response.ok) {
          buf = Buffer.from(await response.arrayBuffer());
          console.log(`Image from URL: ${url} (${buf.length} bytes)`);
        }
      } catch (err) {
        console.log('URL fetch error:', err.message);
      }
    }

    if (!buf) return null;

    if (url && url.includes('res.cloudinary.com') && url.includes('/upload/')) {
      try {
        const compressedUrl = url.replace('/upload/', '/upload/w_900,h_650,c_fill,q_70,f_jpg/');
        const response = await fetch(compressedUrl);

        if (response.ok) {
          const compBuf = Buffer.from(await response.arrayBuffer());
          console.log(`Compressed image: ${compBuf.length} bytes`);
          return `data:image/jpeg;base64,${compBuf.toString('base64')}`;
        }
      } catch (err) {
        console.log('Compression fetch failed:', err.message);
      }
    }

    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  installer = {
    ...defaultInstaller(),
    ...(installer || {}),
  };

  installer.projects = Array.isArray(installer.projects) ? installer.projects : [];

  const [aiImageBase64, ...projectPhotoBase64] = await Promise.all([
    imgToBase64(aiImageUrl, null),
    ...installer.projects.map(project => imgToBase64(project?.photo_url, project?.local_path)),
  ]);

  const aiImageSrc = aiImageBase64 || aiImageUrl;

  const projects = installer.projects.map((project, index) => ({
    ...project,
    photo_url: projectPhotoBase64[index] || project?.photo_url || null,
  }));

  while (projects.length < 6) {
    projects.push({});
  }

  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const validDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

  const proposalNo = `SP-${new Date().getFullYear()}-${jobId.toUpperCase()}`;

  const companyName = safeText(installer.company_name, 'Surya Power Solutions');
  const companyPhone = safeText(installer.phone, '+91 98765 43210');
  const companyEmail = safeText(installer.email, 'info@suryapower.com');
  const companyWebsite = safeText(installer.website, 'www.suryapower.com');
  const companyGst = safeText(installer.gst, 'XXXXXXXXXXXX');
  const customerName = safeText(customer.name, 'Homeowner');
  const customerAddress = safeText(customer.address, '');

  const circleIcon = (label, bg = '#E8F5E9', color = '#1B5E20') => `
    <span style="width:26px;height:26px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0;">${label}</span>
  `;

  const sectionHeader = (subtitle, title) => `
    <div style="background:#1B5E20;padding:40px 48px;color:white;">
      <div style="font-size:12px;font-weight:700;color:#F9A825;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">${subtitle}</div>
      <div style="font-size:32px;font-weight:900;">${title}</div>
    </div>
  `;

  const projectCard = (project, index) => {
    const hasProject = project && (project.name || project.photo_url);

    if (!hasProject) {
      return `
        <div style="width:calc(50% - 12px);height:560px;background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;display:flex;flex-direction:column;">
          <div style="height:230px;background:linear-gradient(135deg,#1B5E20,#2E7D32);display:flex;flex-direction:column;align-items:center;justify-content:center;">
            <div style="width:46px;height:46px;border-radius:50%;background:#F9A825;color:#1B5E20;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;margin-bottom:12px;">P</div>
            <div style="font-size:18px;font-weight:900;color:white;">Project ${index + 1}</div>
          </div>
          <div style="padding:18px;flex:1;">
            <div style="font-size:13px;color:#4A6741;">No project data added</div>
          </div>
        </div>
      `;
    }

    const imgStyle = project.photo_url
      ? `background-image:url('${project.photo_url}');background-size:cover;background-position:center;`
      : `background:linear-gradient(135deg,#1B5E20,#2E7D32);`;

    return `
      <div style="width:calc(50% - 12px);height:560px;background:white;border-radius:16px;overflow:hidden;border:2px solid #C8E6C9;display:flex;flex-direction:column;">
        <div style="height:230px;position:relative;${imgStyle}">
          <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.65),transparent);"></div>
          <div style="position:absolute;bottom:16px;left:16px;right:16px;color:white;">
            <div style="font-size:20px;font-weight:900;">${safeText(project.name, `Project ${index + 1}`)}</div>
            <div style="font-size:12px;margin-top:3px;opacity:0.9;">Location: ${safeText(project.city, '')}</div>
          </div>
        </div>

        <div style="padding:18px;flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <span style="background:#F9A825;color:#1B5E20;font-size:11px;font-weight:900;padding:4px 12px;border-radius:20px;">${safeText(project.cap || project.capacity, '5 kW')} System</span>
            <span style="background:#F1F8E9;color:#2E7D32;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;border:1px solid #C8E6C9;">${safeText(project.roof, 'Flat RCC')}</span>
          </div>

          <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:6px;">Generation: ${safeText(project.kwh, '7,500 kWh/year')} estimated</div>
          <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:6px;">Installed: ${safeText(project.date, '2025')}</div>
          <div style="font-size:12px;color:#4A6741;font-weight:700;margin-bottom:10px;">Rating: ${safeText(project.rating, '4.9/5')}</div>

          ${project.quote ? `
            <div style="margin-top:auto;border-top:1px solid #C8E6C9;padding-top:10px;">
              <div style="font-size:11px;color:#4A6741;font-style:italic;line-height:1.45;">"${safeText(project.quote, '')}"</div>
              <div style="font-size:10px;color:#2E7D32;font-weight:900;margin-top:5px;">— ${safeText(project.quote_author || project.quoteAuthor, '')}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  };

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

  const unitRateForChart = fin.yearlyKwh > 0
    ? fin.annualSaving / fin.yearlyKwh
    : 6;

  const chartBars = monthlyData.map(item => {
    const saving = Math.round(item.v * unitRateForChart);
    const savingShort = saving >= 1000
      ? `&#8377;${(saving / 1000).toFixed(1)}k`
      : `&#8377;${saving}`;

    return `
      <div style="display:flex;flex-direction:column;align-items:center;flex:1;">
        <div style="font-size:8px;color:#1B5E20;font-weight:900;margin-bottom:1px;white-space:nowrap;">${savingShort}</div>
        <div style="font-size:7px;color:#4A6741;font-weight:700;margin-bottom:3px;white-space:nowrap;">${item.v} kWh</div>
        <div style="width:14px;height:${Math.round((item.v / 750) * 70)}px;background:linear-gradient(to top,#8BC34A,#1B5E20);border-radius:2px 2px 0 0;"></div>
        <div style="font-size:7px;font-weight:700;color:#4A6741;margin-top:3px;">${item.m}</div>
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    background:white;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .page {
    width:210mm;
    min-height:297mm;
    position:relative;
    overflow:hidden;
    page-break-after:always;
    display:flex;
    flex-direction:column;
  }
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
          <div style="font-weight:900;font-size:18px;">${companyName}</div>
          <div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;opacity:0.9;">Solutions</div>
        </div>
        <div style="width:40px;height:40px;background:#F9A825;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#1B5E20;">S</div>
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
          ${circleIcon('T', '#F9A825', '#1A2F1A')}
          <span style="color:white;font-weight:600;">${companyPhone}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
          ${circleIcon('W', '#F9A825', '#1A2F1A')}
          <span style="color:white;font-weight:600;">${companyWebsite}</span>
        </div>
        <div style="background:#F9A825;color:#1A2F1A;font-weight:900;text-transform:uppercase;letter-spacing:2px;font-size:12px;padding:10px 28px;display:inline-block;border-radius:4px;">Learn More</div>
      </div>

      <div style="text-align:right;">
        <div style="color:white;font-weight:700;font-size:20px;margin-bottom:16px;">Our Service</div>
        ${[
          'Energy Consultation',
          'System Maintenance',
          'Solar Panel Installation',
          'Battery & Inverter Setup',
        ].map(service => `
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:12px;">
            <span style="color:#C8E6C9;font-weight:600;font-size:13px;">${service}</span>
            ${circleIcon('✓', '#8BC34A', 'white')}
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
          ? `<img src="${installer.logo_url}" style="height:44px;width:44px;border-radius:50%;object-fit:cover;border:2px solid #8BC34A;" />`
          : `<span style="width:36px;height:36px;border-radius:50%;background:#F9A825;color:#1B5E20;display:inline-flex;align-items:center;justify-content:center;font-weight:900;">S</span>`
        }
        <div>
          <div style="font-weight:900;font-size:22px;line-height:1;">${companyName}</div>
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
      <div style="color:#F9A825;font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:13px;margin-bottom:12px;">India's Trusted Rooftop Solar EPC</div>
      <div style="font-size:52px;font-weight:900;color:white;line-height:1.1;">CLEAN ENERGY<br/>PROPOSAL</div>
    </div>

    <div style="flex:1;width:100%;border:4px solid #8BC34A;border-radius:24px;overflow:hidden;position:relative;min-height:220px;">
      <img src="${aiImageSrc}" style="width:100%;height:100%;object-fit:cover;" />
      <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.3),transparent);"></div>
    </div>

    <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;">
      <div style="background:white;padding:20px 24px;border-radius:16px;border:1px solid #C8E6C9;flex:1;max-width:420px;">
        <div style="font-size:10px;font-weight:700;color:#4A6741;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Prepared Exclusively For:</div>
        <div style="font-size:22px;font-weight:900;color:#1A2F1A;margin-bottom:4px;">${customerName}</div>
        <div style="font-size:12px;color:#4A6741;margin-bottom:12px;">${customerAddress}</div>
        <div style="height:1px;background:#C8E6C9;margin-bottom:12px;"></div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">System Size: <span style="color:#F9A825;font-weight:900;font-size:18px;background:#1B5E20;padding:2px 12px;border-radius:6px;">${fin.systemKw} kW</span></div>
      </div>

      <div style="text-align:right;">
        <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;margin-bottom:12px;">
          ${circleIcon('PM', '#F9A825', '#1B5E20')}
          <span style="font-weight:700;color:#1B5E20;font-size:12px;">PM Surya Ghar: Muft Bijli Yojana</span>
          ${circleIcon('✓', '#8BC34A', 'white')}
        </div>
        <div style="font-size:13px;font-weight:700;color:#1B5E20;">Web: ${companyWebsite}</div>
        <div style="font-size:13px;color:#4A6741;margin-top:4px;">Tel: ${companyPhone}</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 2: WELCOME LETTER -->
<div class="page" style="background:#F1F8E9;padding:48px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid #1B5E20;padding-bottom:20px;margin-bottom:36px;">
    <div style="display:flex;align-items:center;gap:10px;color:#1B5E20;">
      ${installer.logo_url
        ? `<img src="${installer.logo_url}" style="height:36px;width:36px;border-radius:50%;object-fit:cover;" />`
        : `<span style="width:32px;height:32px;border-radius:50%;background:#F9A825;color:#1B5E20;display:inline-flex;align-items:center;justify-content:center;font-weight:900;">S</span>`
      }
      <div>
        <div style="font-weight:900;font-size:18px;">${companyName}</div>
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;">Solutions</div>
      </div>
    </div>

    <div style="text-align:right;font-size:12px;color:#4A6741;font-weight:600;">
      <div>${today}</div>
      <div>Ref: ${proposalNo}</div>
    </div>
  </div>

  <div style="font-size:26px;font-weight:900;color:#1A2F1A;margin-bottom:24px;">Dear ${customerName},</div>

  <div style="background:linear-gradient(to right,#FFF8E1,#F1F8E9);border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;gap:16px;margin-bottom:28px;">
    <div style="width:56px;height:56px;background:white;border-radius:50%;border:3px solid #F9A825;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#1B5E20;flex-shrink:0;">PM</div>
    <div>
      <div style="font-size:18px;font-weight:900;color:#1B5E20;">PM Surya Ghar: Muft Bijli Yojana</div>
      <div style="font-size:12px;font-weight:700;color:#2E7D32;margin-top:2px;">Empanelled & Authorized Vendor</div>
    </div>
    <div style="margin-left:auto;background:linear-gradient(to right,#F9A825,#FF8F00);color:white;font-weight:900;padding:8px 16px;border-radius:10px;font-size:12px;">SUBSIDY READY</div>
  </div>

  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">Welcome to <strong style="color:#1B5E20;">${companyName}</strong>. We are excited to present your customised <strong>${fin.systemKw} kW solar system</strong>. As an authorised PM Surya Ghar partner with over ${safeText(installer.years, '8+')} years of excellence, we ensure a seamless transition to clean, affordable energy.</div>

  <div style="font-size:15px;color:#4A6741;line-height:1.8;margin-bottom:20px;">This proposal outlines your exact system specifications, financial savings, and the straightforward roadmap to claiming your <strong style="color:#1B5E20;">${money(fin.subsidyAmount)}</strong> government subsidy.</div>

  <div style="font-size:15px;color:#4A6741;line-height:1.8;">Please review the detailed projections inside. Our technical team is ready to answer any questions.</div>

  <div style="margin-top:32px;color:#1B5E20;font-weight:700;">Warm Regards,</div>
  <div style="font-family:Georgia,serif;font-size:36px;color:#2E7D32;opacity:0.9;margin-top:8px;">${companyName}</div>
  <div style="font-weight:900;color:#1A2F1A;">${companyName}</div>
  <div style="font-size:12px;color:#8BC34A;font-weight:700;">${companyEmail}</div>

  <div style="margin-top:auto;padding-top:28px;display:flex;justify-content:center;">
    <div style="background:white;border:1px solid #C8E6C9;border-radius:16px;padding:16px 28px;text-align:center;">
      <div style="font-size:11px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Authorized & Empanelled</div>
      <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(to right,#F1F8E9,#E8F5E9);border:1px solid #C8E6C9;padding:8px 16px;border-radius:20px;">
        ${circleIcon('PM', '#F9A825', '#1B5E20')}
        <span style="font-weight:700;color:#1B5E20;font-size:13px;">PM Surya Ghar: Muft Bijli Yojana</span>
        ${circleIcon('✓', '#8BC34A', 'white')}
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
        { label: 'In Business', value: safeText(installer.years, '8+'), icon: 'Y' },
        { label: 'Installations', value: safeText(installer.installations, '450+'), icon: 'I' },
        { label: 'Capacity', value: safeText(installer.total_kw, '2.1 MW'), icon: 'C' },
        { label: 'Rating', value: safeText(installer.rating, '4.9/5'), icon: 'R' },
      ].map((item, index) => `
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:44px;height:44px;background:#E8F5E9;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#1B5E20;">${item.icon}</div>
          <div>
            <div style="font-size:18px;font-weight:900;color:#1B5E20;">${item.value}</div>
            <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${item.label}</div>
          </div>
        </div>
        ${index < 3 ? '<div style="width:1px;height:40px;background:#C8E6C9;"></div>' : ''}
      `).join('')}
    </div>

    <div style="display:flex;gap:24px;flex:1;">
      ${projectCard(projects[0], 0)}
      ${projectCard(projects[1], 1)}
    </div>
  </div>
</div>

<!-- PAGE 4: PROJECTS 2 -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;">
      ${projectCard(projects[2], 2)}
      ${projectCard(projects[3], 3)}
    </div>
  </div>
</div>

<!-- PAGE 5: PROJECTS 3 -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Our Track Record', 'Installer Profile & Past Projects')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;gap:24px;flex:1;margin-bottom:24px;">
      ${projectCard(projects[4], 4)}
      ${projectCard(projects[5], 5)}
    </div>

    <div style="background:#1B5E20;color:white;border-radius:16px;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
      ${[
        { icon: 'M', label: 'MNRE Empanelled', sub: 'Installer' },
        { icon: 'T', label: 'Tier-1 Brands Only', sub: 'Waaree, Adani, Vikram' },
        { icon: 'A', label: '5 Year Free AMC', sub: 'Included' },
      ].map((item, index) => `
        <div style="display:flex;align-items:center;gap:12px;flex:1;justify-content:center;">
          <div style="background:#8BC34A;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#1B5E20;font-weight:900;font-size:16px;">${item.icon}</div>
          <div style="text-align:center;">
            <div style="font-weight:700;font-size:13px;">${item.label}</div>
            <div style="font-size:10px;opacity:0.8;">${item.sub}</div>
          </div>
        </div>
        ${index < 2 ? '<div style="width:1px;height:40px;background:rgba(255,255,255,0.2);"></div>' : ''}
      `).join('')}
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
      <div style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:white;font-weight:700;font-size:13px;background:rgba(0,0,0,0.5);padding:6px 16px;border-radius:20px;">AI Generated - Your Actual Roof View</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
      ${[
        { title: 'System Size', value: `${fin.systemKw} kW`, icon: 'P' },
        { title: 'Solar Panels', value: `${panelCount}x ${safeText(panelBrand.split(' ')[0], 'Panel')} 550W`, icon: 'S' },
        { title: 'Orientation', value: 'South / 25 deg Tilt', icon: 'O' },
        { title: 'Connection', value: 'On-Grid Net Meter', icon: 'G' },
      ].map(item => `
        <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
          <div style="width:28px;height:28px;border-radius:50%;background:#E8F5E9;color:#1B5E20;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;margin-bottom:8px;">${item.icon}</div>
          <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${item.title}</div>
          <div style="font-size:14px;font-weight:900;color:#1A2F1A;">${item.value}</div>
        </div>
      `).join('')}
    </div>

    <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="background:linear-gradient(135deg,#8BC34A,#2E7D32);width:54px;height:54px;border-radius:50%;font-size:16px;font-weight:900;color:white;display:flex;align-items:center;justify-content:center;">E</div>
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
      <div style="background:#1B5E20;padding:12px 20px;color:white;font-weight:700;font-size:14px;">Detailed Specifications</div>
      ${[
        ['System Type', 'Grid-Tied (On-Grid) Rooftop Solar PV System'],
        ['Panel Model', `${safeText(panelBrand, 'Waaree Solar')} 550W Monocrystalline PERC Half-Cut`],
        ['Inverter Model', `${safeText(inverterBrand, 'Solis')} ${fin.systemKw}kW String Inverter (Wi-Fi Enabled)`],
        ['Mounting Structure', 'Hot-Dip Galvanized (HDG) MS, 25 deg Optimal Tilt'],
        ['Estimated Annual Gen.', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh (Units) per year`],
      ].map((row, index) => `
        <div style="display:flex;border-bottom:1px solid #C8E6C9;background:${index % 2 === 0 ? '#F1F8E9' : 'white'};">
          <div style="padding:12px 20px;width:40%;font-size:12px;font-weight:700;color:#4A6741;">${row[0]}</div>
          <div style="padding:12px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${row[1]}</div>
        </div>
      `).join('')}
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
        <div style="font-size:20px;font-weight:900;color:#1A2F1A;margin-top:6px;">${money(fin.quotedPrice)}</div>
      </div>

      <div style="background:#E8F5E9;border:2px solid #8BC34A;border-radius:12px;padding:16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;right:0;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:3px 8px;border-radius:0 0 0 8px;">APPROVED</div>
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">PM Surya Ghar Subsidy</div>
        <div style="font-size:20px;font-weight:900;color:#2E7D32;margin-top:6px;">${money(fin.subsidyAmount)}</div>
      </div>

      <div style="background:#1B5E20;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#8BC34A;text-transform:uppercase;letter-spacing:1px;">Your Net Investment</div>
        <div style="font-size:24px;font-weight:900;color:white;margin-top:6px;">${money(fin.netCost)}</div>
      </div>

      <div style="background:#F1F8E9;border:2px solid #C8E6C9;border-radius:12px;padding:16px;">
        <div style="font-size:10px;font-weight:700;color:#2E7D32;text-transform:uppercase;letter-spacing:1px;">Payback Period</div>
        <div style="font-size:20px;font-weight:900;color:#1B5E20;margin-top:6px;">${fin.payback} Years</div>
      </div>
    </div>

    <div style="display:flex;gap:24px;">
      <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:16px;overflow:hidden;">
        <div style="background:#E8F5E9;padding:14px 20px;border-bottom:2px solid #C8E6C9;">
          <div style="font-weight:900;color:#1B5E20;font-size:14px;">Savings Projections</div>
        </div>

        ${[
          ['Annual Generation', `${fin.yearlyKwh.toLocaleString('en-IN')} kWh`, '#1A2F1A'],
          ['Current Monthly Bill', money(fin.monthlyBefore), '#1A2F1A'],
          ['Monthly Savings', money(Math.round(fin.annualSaving / 12)), '#2E7D32'],
          ['Annual Savings', money(fin.annualSaving), '#2E7D32'],
          ['10 Year Savings', money(fin.annualSaving * 10), '#1A2F1A'],
          ['25 Year Savings', money(fin.annualSaving * 25), '#1A2F1A'],
          ['25 Year Net Profit', money(fin.saving25yr), '#F9A825'],
        ].map(row => `
          <div style="display:flex;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #C8E6C9;">
            <span style="font-size:12px;color:#4A6741;font-weight:600;">${row[0]}</span>
            <span style="font-size:12px;font-weight:900;color:${row[2]};">${row[1]}</span>
          </div>
        `).join('')}
      </div>

      <div style="flex:1;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;gap:12px;">
          <div style="flex:1;background:white;border:2px solid #C8E6C9;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:10px;color:#4A6741;font-weight:700;text-transform:uppercase;margin-bottom:6px;">Before Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1A2F1A;">${money(fin.monthlyBefore)}</div>
            <div style="font-size:10px;color:#4A6741;margin-top:4px;">per month</div>
          </div>

          <div style="flex:1;background:#F1F8E9;border:2px solid #8BC34A;border-radius:12px;padding:14px;text-align:center;position:relative;overflow:hidden;">
            <div style="position:absolute;top:-4px;right:-16px;background:#8BC34A;color:white;font-size:9px;font-weight:900;padding:4px 24px;transform:rotate(45deg);">SAVE ${fin.savePct}%</div>
            <div style="font-size:10px;color:#2E7D32;font-weight:700;text-transform:uppercase;margin-bottom:6px;">After Solar</div>
            <div style="font-size:22px;font-weight:900;color:#1B5E20;">${money(fin.monthlyAfter)}</div>
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
            [safeText(panelBrand, 'Solar Panel'), `${safeText(panelBrand, 'Solar Panel')} 550W Mono PERC Half Cut`, `${panelCount} Nos`, '25yr Performance / 10yr Product'],
            ['Inverter', `${safeText(inverterBrand, 'Inverter')} ${fin.systemKw}kW Wi-Fi String Inverter IP65`, '1 No', '10 Years'],
            ['Structure', 'GI/MS Hot Dip Galvanized 25 deg MNRE Approved', '1 Set', '10 Years'],
            ['DC Cables', '4mm UV Resistant with MC4 Connectors', 'As Req.', '10 Years'],
            ['AC DB Box', 'IP65 Enclosure with SPD, MCB, Isolator', '1 No', '2 Years'],
            ['Earthing & LA', 'Maintenance-free GI Plate & Lightning Arrester', '1 Set', '5 Years'],
            ['Net Meter', 'Bidirectional DISCOM Approved Meter', '1 No', 'Per DISCOM'],
          ].map((row, index) => `
            <tr style="border-bottom:1px solid #C8E6C9;background:${index % 2 === 0 ? 'white' : '#F1F8E9'};">
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${row[0]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:700;color:#4A6741;">${row[1]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#1B5E20;text-align:center;background:#E8F5E9;">${row[2]}</td>
              <td style="padding:12px 20px;font-size:12px;font-weight:900;color:#2E7D32;">${row[3]}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:16px 20px;display:flex;gap:16px;">
      <div style="background:#E8F5E9;width:40px;height:40px;border-radius:50%;font-size:16px;font-weight:900;color:#1B5E20;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:flex-start;">B</div>
      <div>
        <div style="font-size:15px;font-weight:900;color:#1B5E20;margin-bottom:6px;">Balance of System (BOS) Inclusion Note:</div>
        <div style="font-size:12px;color:#4A6741;font-weight:600;line-height:1.6;">All necessary civil work for foundation blocks, PVC conduits, junction boxes, cable trays, and minor hardware required for a safe, code-compliant installation are included in the system cost.</div>
        <div style="font-size:11px;color:#4A6741;font-weight:600;line-height:1.6;margin-top:8px;">Final brand/model may vary based on stock availability, site condition, and DISCOM requirements. Equivalent or higher specification material will be supplied.</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 9: PRICING & PAYMENT -->
<div class="page" style="background:#F1F8E9;">
  ${sectionHeader('Commercials', 'Pricing & Payment Terms')}
  <div style="padding:28px 48px;display:flex;flex-direction:column;gap:22px;">
    <div style="background:white;border:4px solid #1B5E20;border-radius:16px;padding:28px;position:relative;margin-top:12px;">
      <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);background:#1B5E20;color:white;padding:6px 20px;border-radius:20px;font-weight:700;font-size:12px;letter-spacing:2px;text-transform:uppercase;white-space:nowrap;">Final Quotation</div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-top:8px;">
        <span style="font-size:17px;font-weight:700;color:#4A6741;">Total System Cost</span>
        <span style="font-size:20px;font-weight:900;color:#1A2F1A;">${money(fin.quotedPrice)}</span>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:20px;border-bottom:2px dashed #C8E6C9;color:#2E7D32;">
        <span style="font-size:15px;font-weight:700;">Less: PM Surya Ghar Subsidy</span>
        <span style="font-size:17px;font-weight:900;">- ${money(fin.subsidyAmount)}</span>
      </div>

      <div style="background:#F1F8E9;padding:20px 24px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;border:1px solid #C8E6C9;">
        <div>
          <div style="font-size:11px;font-weight:900;color:#1B5E20;text-transform:uppercase;letter-spacing:2px;">Net Amount Payable</div>
          <div style="font-size:10px;color:#4A6741;margin-top:2px;">*Excluding GST as applicable</div>
        </div>
        <div style="font-size:44px;font-weight:900;color:#1B5E20;">${money(fin.netCost)}</div>
      </div>
    </div>

    <div>
      <div style="font-size:17px;font-weight:900;color:#1B5E20;margin-bottom:12px;">Payment Milestones</div>
      <div style="background:white;border:2px solid #C8E6C9;border-radius:12px;overflow:hidden;">
        <table>
          <thead>
            <tr style="background:#E8F5E9;color:#2E7D32;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">
              <th style="padding:12px 20px;text-align:left;">Milestone</th>
              <th style="padding:12px 20px;text-align:left;">Timeline</th>
              <th style="padding:12px 20px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${[
              ['20% Advance', 'On Proposal Signing (Due Today)', money(fin.advance)],
              ['70% Material Readiness', 'Before Material Delivery (Day 3-5)', money(fin.material)],
              ['10% Commissioning', 'After Meter Install & Testing', money(fin.final)],
            ].map((row, index) => `
              <tr style="border-top:1px solid #C8E6C9;background:${index % 2 === 1 ? '#F1F8E9' : 'white'};">
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;">${row[0]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:700;color:#4A6741;">${row[1]}</td>
                <td style="padding:13px 20px;font-size:12px;font-weight:900;color:#1A2F1A;text-align:right;">${row[2]}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#1B5E20;color:white;padding:20px;border-radius:16px;">
        <div style="font-size:11px;font-weight:900;color:#F9A825;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.2);">Bank Details</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Bank:</span>${safeText(installer.bank_name, 'HDFC Bank')}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">Account:</span>${safeText(installer.account_no, 'XXXX XXXX XXXX')}</div>
        <div style="font-size:12px;margin-bottom:8px;"><span style="color:#8BC34A;font-weight:700;display:inline-block;width:70px;">IFSC:</span>${safeText(installer.ifsc, 'HDFC0001234')}</div>
        <div style="font-size:12px;font-weight:900;color:#F9A825;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.2);">UPI: ${safeText(installer.upi, 'contact@suryapower.com')}</div>
      </div>

      <div style="background:white;border:2px solid #8BC34A;border-radius:16px;padding:20px;">
        <div style="font-size:14px;font-weight:900;color:#1B5E20;margin-bottom:10px;">Important Note</div>
        <div style="font-size:12px;color:#4A6741;line-height:1.7;">GST at prevailing rates will be charged extra. The PM Surya Ghar subsidy of ${money(fin.subsidyAmount)} will be credited <strong style="color:#1B5E20;">directly to your linked bank account</strong> by the government, subject to applicable approval.</div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 10: NEXT STEPS + FOOTER -->
<div class="page" style="background:#F1F8E9;padding:48px;display:flex;flex-direction:column;">
  <div style="margin-bottom:36px;">
    <div style="font-size:28px;font-weight:900;color:#1B5E20;text-align:center;margin-bottom:32px;">Your Journey to Clean Energy</div>

    <div style="position:relative;display:flex;justify-content:space-between;align-items:flex-start;">
      <div style="position:absolute;top:28px;left:0;width:100%;height:4px;background:#C8E6C9;border-radius:2px;z-index:0;"></div>

      ${[
        { no: 1, label: 'Sign Proposal' },
        { no: 2, label: '20% Advance' },
        { no: 3, label: 'Site Survey' },
        { no: 4, label: 'Installation' },
        { no: 5, label: 'Net Metering' },
        { no: 6, label: 'Subsidy Credit' },
      ].map(step => `
        <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div style="width:56px;height:56px;border-radius:50%;background:#1B5E20;color:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;border:4px solid #F1F8E9;">${step.no}</div>
          <div style="font-size:10px;font-weight:900;color:#2E7D32;text-align:center;width:70px;line-height:1.3;text-transform:uppercase;">${step.label}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:36px;">
    <div style="background:white;border:2px solid #C8E6C9;border-radius:16px;padding:20px;">
      <div style="font-size:16px;font-weight:900;color:#1B5E20;margin-bottom:14px;">Scope Included</div>
      ${[
        'All Solar Materials & Components',
        'End-to-End Installation & Wiring',
        'Custom Mounting Structure',
        'Subsidy Documentation & Portal Entry',
        'Net Meter Application Process',
        '1 Year Free Workmanship Warranty',
      ].map(item => `
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
          <span style="width:16px;height:16px;border-radius:50%;background:#8BC34A;color:white;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;flex-shrink:0;">✓</span>
          <span style="font-size:12px;color:#4A6741;font-weight:700;">${item}</span>
        </div>
      `).join('')}
    </div>

    <div style="background:white;border:2px solid #C8E6C9;border-radius:16px;padding:20px;">
      <div style="font-size:16px;font-weight:900;color:#1B5E20;margin-bottom:14px;">Scope Excluded</div>
      ${[
        'Official DISCOM / Utility Fees',
        'Major Pre-existing Electrical Upgrades',
        'Major Civil Roof Repairs before installation',
        'Water arrangement for panel cleaning',
      ].map(item => `
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
          <span style="width:16px;height:16px;border-radius:50%;background:#C8E6C9;color:#1B5E20;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;flex-shrink:0;">-</span>
          <span style="font-size:12px;color:#4A6741;font-weight:700;">${item}</span>
        </div>
      `).join('')}
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;margin-bottom:36px;">
    <div style="width:38%;text-align:center;border-top:2px solid #1B5E20;padding-top:12px;">
      <div style="font-weight:900;color:#1A2F1A;">${customerName}</div>
      <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Customer Acceptance & Date</div>
    </div>

    <div style="width:38%;text-align:center;border-top:2px solid #1B5E20;padding-top:12px;">
      <div style="font-weight:900;color:#1A2F1A;">${companyName}</div>
      <div style="font-size:9px;color:#4A6741;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Authorised Signatory - ${today}</div>
    </div>
  </div>

  <div style="margin-top:auto;background:#1B5E20;color:white;border-radius:24px 24px 0 0;padding:32px 40px;text-align:center;">
    <div style="font-size:28px;font-weight:900;margin-bottom:10px;">Thank You for Choosing Clean Energy</div>
    <div style="color:#8BC34A;font-size:16px;font-weight:700;margin-bottom:22px;">Together we are building a sustainable India.</div>

    <div style="display:flex;justify-content:center;gap:24px;border-top:1px solid rgba(139,195,74,0.4);border-bottom:1px solid rgba(139,195,74,0.4);padding:16px 0;margin-bottom:18px;font-size:12px;font-weight:700;">
      <span>Tel: ${companyPhone}</span>
      <span>Email: ${companyEmail}</span>
      <span>Web: ${companyWebsite}</span>
    </div>

    <div style="font-size:11px;color:#C8E6C9;font-weight:600;letter-spacing:0.5px;">
      ${companyName} | GST: ${companyGst} | Powered by SolarQuote
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
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const page = await browser.newPage();

  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  page.on('console', message => console.log('PAGE LOG:', message.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

  await page.setContent(html, {
    waitUntil: 'networkidle0',
    timeout: 90000,
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
  });

  await browser.close();

  console.log(`PDF generated: ${pdfBuffer.length} bytes`);

  fs.writeFileSync(pdfPath, pdfBuffer);
  return pdfBuffer;
}

// ---------------------------- SERVE ------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`solarscan running on port ${PORT}`);
});
