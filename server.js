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
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'static')));

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error('Cloudinary variables missing. Check Railway variables.');
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY missing. Check Railway variables.');
}

console.log('Cloudinary cloud_name:', CLOUDINARY_CLOUD_NAME);
console.log('Cloudinary api_key length:', CLOUDINARY_API_KEY.length);
console.log('Cloudinary api_secret length:', CLOUDINARY_API_SECRET.length);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TMP = '/tmp/solarscan';
fs.mkdirSync(TMP, { recursive: true });

// ---------------------------- BASIC HELPERS ----------------------------------

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
  return `₹${n.toLocaleString('en-IN')}`;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getPanelLayout(count) {
  if (count <= 12) return { rows: 2, cols: Math.ceil(count / 2) };
  if (count <= 21) return { rows: 3, cols: Math.ceil(count / 3) };
  return { rows: 4, cols: Math.ceil(count / 4) };
}

function parseJsonSafe(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ---------------------------- RATE MASTER ------------------------------------

function defaultRateMaster() {
  return {
    panel_rates: {
      'Waaree Solar': 22,
      'Adani Solar': 23,
      'Vikram Solar': 22,
      'Tata Power Solar': 24,
      'Renewsys Solar': 21,
    },

    inverter_base_costs: {
      Solis: 35000,
      Growatt: 32000,
      Havells: 38000,
      SolarEdge: 65000,
      Fronius: 70000,
    },

    structure_rates: {
      normal: 8000,
      elevated: 14000,
      shed: 6500,
      custom: 16000,
    },

    labour_access_multiplier: {
      easy: 1,
      medium: 1.15,
      difficult: 1.35,
    },

    default_panel_rate: 22,
    default_inverter_base_cost: 35000,
    default_structure_rate: 8000,

    height_extra_per_ft_per_kw: 1500,
    extra_inverter_cost_per_kw_above_5kw: 5000,

    cable_rate_per_meter: 120,
    labour_rate_per_kw: 5000,

    ac_dc_box_cost: 9000,
    earthing_la_cost: 9000,

    net_meter_single_phase_cost: 7000,
    net_meter_three_phase_cost: 10000,

    transport_cost: 5000,
    misc_cost: 8000,

    gst_rate_percent: 12,
    margin_percent: 25,
  };
}

function mergeRateMaster(rateMaster = {}) {
  const defaults = defaultRateMaster();

  const merged = {
    ...defaults,
    ...(rateMaster || {}),

    panel_rates: {
      ...defaults.panel_rates,
      ...((rateMaster || {}).panel_rates || {}),
    },

    inverter_base_costs: {
      ...defaults.inverter_base_costs,
      ...((rateMaster || {}).inverter_base_costs || {}),
    },

    structure_rates: {
      ...defaults.structure_rates,
      ...((rateMaster || {}).structure_rates || {}),
    },

    labour_access_multiplier: {
      ...defaults.labour_access_multiplier,
      ...((rateMaster || {}).labour_access_multiplier || {}),
    },
  };

  Object.keys(merged.panel_rates).forEach(key => {
    merged.panel_rates[key] = toNumber(
      merged.panel_rates[key],
      defaults.panel_rates[key] || defaults.default_panel_rate
    );
  });

  Object.keys(merged.inverter_base_costs).forEach(key => {
    merged.inverter_base_costs[key] = toNumber(
      merged.inverter_base_costs[key],
      defaults.inverter_base_costs[key] || defaults.default_inverter_base_cost
    );
  });

  Object.keys(merged.structure_rates).forEach(key => {
    merged.structure_rates[key] = toNumber(
      merged.structure_rates[key],
      defaults.structure_rates[key] || defaults.default_structure_rate
    );
  });

  Object.keys(merged.labour_access_multiplier).forEach(key => {
    merged.labour_access_multiplier[key] = toNumber(
      merged.labour_access_multiplier[key],
      defaults.labour_access_multiplier[key] || 1
    );
  });

  [
    'default_panel_rate',
    'default_inverter_base_cost',
    'default_structure_rate',
    'height_extra_per_ft_per_kw',
    'extra_inverter_cost_per_kw_above_5kw',
    'cable_rate_per_meter',
    'labour_rate_per_kw',
    'ac_dc_box_cost',
    'earthing_la_cost',
    'net_meter_single_phase_cost',
    'net_meter_three_phase_cost',
    'transport_cost',
    'misc_cost',
    'gst_rate_percent',
    'margin_percent',
  ].forEach(key => {
    merged[key] = toNumber(merged[key], defaults[key]);
  });

  return merged;
}

// ---------------------------- INSTALLER PROFILE ------------------------------

function defaultInstaller() {
  return {
    company_name: 'Solar Installer',
    tagline: '',
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

    rate_master: defaultRateMaster(),
  };
}

function normalizeInstaller(profile = {}) {
  return {
    ...defaultInstaller(),
    ...(profile || {}),
    projects: Array.isArray(profile.projects) ? profile.projects : [],
    rate_master: mergeRateMaster(profile.rate_master || {}),
  };
}

// ---------------------------- PRICING ENGINE ---------------------------------

function estimateSubsidy(systemKw, customerType) {
  if (customerType !== 'residential') return 0;

  if (systemKw >= 3) return 78000;
  if (systemKw >= 2) return 60000;
  if (systemKw >= 1) return 30000;

  return 0;
}

function calculateSiteCost(systemKw, panelBrand, inverterBrand, site = {}, rateMaster = {}) {
  const rates = mergeRateMaster(rateMaster);

  const panelRate = toNumber(
    rates.panel_rates[panelBrand],
    rates.default_panel_rate
  );

  const inverterBase = toNumber(
    rates.inverter_base_costs[inverterBrand],
    rates.default_inverter_base_cost
  );

  const cableDistance = toNumber(site.cableDistance, 30);
  const structureHeight = toNumber(site.structureHeight, 3);

  const mountingType = site.mountingType || 'normal';
  const rooftopAccess = site.rooftopAccess || 'easy';

  const structureRate = toNumber(
    rates.structure_rates[mountingType],
    rates.default_structure_rate
  );

  const labourMultiplier = toNumber(
    rates.labour_access_multiplier[rooftopAccess],
    1
  );

  const heightExtra = Math.round(
    Math.max(0, structureHeight - 3) *
    systemKw *
    rates.height_extra_per_ft_per_kw
  );

  const panelCost = Math.round(systemKw * 1000 * panelRate);

  const inverterCost = Math.round(
    inverterBase +
    Math.max(0, systemKw - 5) * rates.extra_inverter_cost_per_kw_above_5kw
  );

  const structureCost = Math.round(systemKw * structureRate + heightExtra);

  const cableCost = Math.round(cableDistance * rates.cable_rate_per_meter);

  const labourCost = Math.round(
    systemKw *
    rates.labour_rate_per_kw *
    labourMultiplier
  );

  const acDcBoxCost = Math.round(rates.ac_dc_box_cost);
  const earthingLaCost = Math.round(rates.earthing_la_cost);

  const netMeteringCost =
    site.phaseType === 'three'
      ? Math.round(rates.net_meter_three_phase_cost)
      : Math.round(rates.net_meter_single_phase_cost);

  const transportCost = Math.round(rates.transport_cost);
  const miscCost = Math.round(rates.misc_cost);

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

  const gstAmount = Math.round(baseCost * (rates.gst_rate_percent / 100));

  const installerCost = baseCost + gstAmount;

  const marginAmount = Math.round(installerCost * (rates.margin_percent / 100));

  const suggestedQuote =
    Math.ceil((installerCost + marginAmount) / 1000) * 1000;

  return {
    panelCost,
    inverterCost,
    structureCost,
    heightExtra,
    cableCost,
    labourCost,
    acDcBoxCost,
    earthingLaCost,
    netMeteringCost,
    transportCost,
    miscCost,
    baseCost,
    gstAmount,
    installerCost,
    marginAmount,
    suggestedQuote,
    ratesUsed: rates,
  };
}

function calcFinancials(
  systemKw,
  monthlyBill,
  quotedPriceInput,
  subsidyAmountInput,
  site = {},
  panelBrand = 'Waaree Solar',
  inverterBrand = 'Solis',
  rateMaster = {}
) {
  const siteCost = calculateSiteCost(
    systemKw,
    panelBrand,
    inverterBrand,
    site,
    rateMaster
  );

  const quotedPrice =
    Number(quotedPriceInput || 0) > 0
      ? Number(quotedPriceInput)
      : siteCost.suggestedQuote;

  const subsidyAmount =
    Number(subsidyAmountInput || 0) > 0
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

  const unitRate =
    monthlyUnits > 0
      ? Math.max(5, Math.min(monthlyBill / monthlyUnits, 15))
      : Math.max(6, Math.min((monthlyBill * 12) / Math.max(yearlyKwh, 1), 12));

  const annualSaving = Math.round(yearlyKwh * unitRate);

  const payback = (netCost / Math.max(annualSaving, 1)).toFixed(1);

  const saving25yr = Math.round(annualSaving * 25 - netCost);

  const monthlyAfter = Math.max(
    0,
    Math.round(monthlyBill - annualSaving / 12)
  );

  const savePct =
    monthlyBill > 0
      ? Math.round(((monthlyBill - monthlyAfter) / monthlyBill) * 100)
      : 0;

  const co2 = ((yearlyKwh * 0.82) / 1000).toFixed(1);
  const trees = Math.round((yearlyKwh * 0.82) / 1000 * 24);

  const estimatedMargin = quotedPrice - siteCost.installerCost;

  const estimatedMarginPct =
    quotedPrice > 0
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

    unitRate: Number(unitRate.toFixed(2)),
    site,

    advance: Math.round(netCost * 0.20),
    material: Math.round(netCost * 0.70),
    final: Math.round(netCost * 0.10),
  };
}

function buildSiteFromBody(body = {}) {
  return {
    customerType: body.customer_type || 'residential',
    cityDiscom: body.city_discom || 'other',
    monthlyUnits: parseInt(body.monthly_units || 0),
    sanctionedLoad: parseFloat(body.sanctioned_load || 0),
    cableDistance: parseFloat(body.cable_distance || 30),
    phaseType: body.phase_type || 'single',
    mountingType: body.mounting_type || 'normal',
    structureHeight: parseFloat(body.structure_height || 3),
    shading: body.shading || 'none',
    rooftopAccess: body.rooftop_access || 'easy',
    roofType: body.roof_type || 'flat_rcc',
  };
}

// ---------------------------- AI PROMPT --------------------------------------

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
    `The roof type is ${roofType}. ` +
    `The camera was pointing NORTH. Therefore all solar panels must face TRUE SOUTH, directly toward the camera. The full front glass surface of all panels must be visible. ` +
    `Preserve the original roof photo completely. Do not change roof geometry, parapet walls, vents, tanks, AC units, pipes, trees, towers, buildings, sky, or background. ` +
    `Add realistic shadows under panels, support rods, frames, and RCC blocks matching the original sunlight direction. ` +
    `Strict negative instructions: do not create one continuous solar sheet. Do not merge panels. Do not change panel count. Do not create floating panels. Do not distort roof or background.`
  );
}

// ---------------------------- CLOUDINARY UPLOAD ------------------------------

async function uploadToCloudinary(buffer, folder, publicId, resourceType = 'image') {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

  const isProfile = publicId.includes('profile');

  const fileName =
    resourceType === 'raw'
      ? isProfile
        ? `${publicId}.json`
        : `${publicId}.pdf`
      : `${publicId}.jpg`;

  const fileType =
    resourceType === 'raw'
      ? isProfile
        ? 'application/json'
        : 'application/pdf'
      : 'image/jpeg';

  const formData = new FormData();

  formData.append('file', new Blob([buffer], { type: fileType }), fileName);
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('overwrite', 'true');

  const authHeader = Buffer.from(
    `${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`
  ).toString('base64');

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

// ---------------------------- PROFILE LOAD HELPER ----------------------------

async function loadInstallerProfile(installerId) {
  const profilePath = path.join(TMP, `profile_${installerId}.json`);

  if (fs.existsSync(profilePath)) {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    return normalizeInstaller(profile);
  }

  const urlsToTry = [
    `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/raw/upload/solarscan/${installerId}/profile.json`,
    `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/raw/upload/solarscan/${installerId}/profile`,
  ];

  for (const url of urlsToTry) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        const profile = await response.json();
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
        console.log('Profile restored from Cloudinary');
        return normalizeInstaller(profile);
      }

      console.log('Cloudinary profile fetch status:', response.status, url);
    } catch (err) {
      console.log('Cloudinary profile fetch error:', err.message);
    }
  }

  return normalizeInstaller(defaultInstaller());
}

// ---------------------------- SAVE PROFILE -----------------------------------

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

    const profile = parseJsonSafe(req.body.profile_json, {});
    profile.rate_master = mergeRateMaster(profile.rate_master || {});

    if (req.files?.logo?.[0]) {
      profile.logo_url = await uploadToCloudinary(
        req.files.logo[0].buffer,
        `solarscan/${installerId}`,
        'logo',
        'image'
      );
    }

    profile.projects = Array.isArray(profile.projects) ? profile.projects : [];

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

    const finalProfile = normalizeInstaller(profile);

    const profilePath = path.join(TMP, `profile_${installerId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(finalProfile, null, 2));

    await uploadToCloudinary(
      Buffer.from(JSON.stringify(finalProfile, null, 2)),
      `solarscan/${installerId}`,
      'profile',
      'raw'
    );

    res.json({
      success: true,
      profile: finalProfile,
    });
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------- LOAD PROFILE -----------------------------------

app.get('/api/load-profile', async (req, res) => {
  try {
    const installerId = req.query.installer_id || 'default';
    const profile = await loadInstallerProfile(installerId);

    res.json({
      success: true,
      profile,
    });
  } catch (err) {
    console.error('Load profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------- CALCULATE PRICE --------------------------------

app.post('/api/calculate-price', async (req, res) => {
  try {
    const installerId = req.body.installer_id || 'default';

    const installer = await loadInstallerProfile(installerId);

    const systemKw = parseFloat(req.body.system_kw || 5);
    const monthlyBill = parseInt(req.body.monthly_bill || 3000);

    const quotedPrice = parseInt(req.body.quoted_price || 0);
    const subsidyAmount = parseInt(req.body.subsidy_amount || 0);

    const panelBrand = req.body.panel_brand || 'Waaree Solar';
    const inverterBrand = req.body.inverter_brand || 'Solis';

    const site = buildSiteFromBody(req.body);

    const fin = calcFinancials(
      systemKw,
      monthlyBill,
      quotedPrice,
      subsidyAmount,
      site,
      panelBrand,
      inverterBrand,
      installer.rate_master
    );

    res.json({
      success: true,
      financials: fin,
      rate_master: installer.rate_master,
    });
  } catch (err) {
    console.error('Calculate price error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------- GENERATE QUOTE ---------------------------------

app.post('/api/generate-quote', upload.single('photo'), async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  try {
    if (!req.file?.buffer) {
      throw new Error('No roof photo uploaded');
    }

    const installerId = req.body.installer_id || 'default';

    const installer = await loadInstallerProfile(installerId);

    const systemKw = parseFloat(req.body.system_kw || 5);
    const panelWatt = parseInt(req.body.panel_watt || 550);
    const panelCount = Math.ceil((systemKw * 1000) / panelWatt);

    const quotedPrice = parseInt(req.body.quoted_price || 0);
    const subsidyAmount = parseInt(req.body.subsidy_amount || 0);
    const monthlyBill = parseInt(req.body.monthly_bill || 3000);

    const roofType = req.body.roof_type || 'flat_rcc';
    const panelBrand = req.body.panel_brand || 'Waaree Solar';
    const inverterBrand = req.body.inverter_brand || 'Solis';

    const site = buildSiteFromBody(req.body);

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
      inverterBrand,
      installer.rate_master
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

// ---------------------------- PDF GENERATION ---------------------------------

async function imageToBase64(url, localPath) {
  let buf = null;

  if (localPath && fs.existsSync(localPath)) {
    try {
      buf = fs.readFileSync(localPath);
    } catch (err) {
      console.log('Local image read failed:', err.message);
    }
  }

  if (!buf && url) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        buf = Buffer.from(await response.arrayBuffer());
      }
    } catch (err) {
      console.log('Image URL fetch failed:', err.message);
    }
  }

  if (!buf) return null;

  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function costRow(label, value, strong = false) {
  return `
    <tr>
      <td>${safeText(label)}</td>
      <td style="text-align:right;font-weight:${strong ? '900' : '700'};">${money(value)}</td>
    </tr>
  `;
}

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
  installer = normalizeInstaller(installer);

  const aiImageSrc = await imageToBase64(aiImageUrl, null);

  const projects = Array.isArray(installer.projects) ? installer.projects.slice(0, 6) : [];

  while (projects.length < 6) {
    projects.push({});
  }

  const projectImages = await Promise.all(
    projects.map(project => imageToBase64(project.photo_url, project.local_path))
  );

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

  const companyName = safeText(installer.company_name, 'Solar Installer');
  const companyPhone = safeText(installer.phone, '+91 98765 43210');
  const companyEmail = safeText(installer.email, 'info@example.com');
  const companyWebsite = safeText(installer.website, '');
  const companyGst = safeText(installer.gst, '');

  const customerName = safeText(customer.name, 'Homeowner');
  const customerAddress = safeText(customer.address, '');

  const cb = fin.costBreakup || {};

  const projectCards = projects.map((project, index) => {
    const img = projectImages[index];

    const hasProject = project && (project.name || img);

    if (!hasProject) {
      return '';
    }

    return `
      <div class="project-card">
        ${img ? `<img src="${img}" />` : `<div class="project-placeholder">Project ${index + 1}</div>`}
        <div class="project-body">
          <h3>${safeText(project.name, `Project ${index + 1}`)}</h3>
          <p><b>Location:</b> ${safeText(project.city, '')}</p>
          <p><b>Capacity:</b> ${safeText(project.cap || project.capacity, '5 kW')}</p>
          <p><b>Roof:</b> ${safeText(project.roof, 'Flat RCC')}</p>
          <p><b>Generation:</b> ${safeText(project.kwh, '7,500 kWh/year')}</p>
          ${project.quote ? `<p class="quote">"${safeText(project.quote)}"</p>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  body {
    font-family: Arial, sans-serif;
    background: white;
    color: #1A2F1A;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .page {
    width: 210mm;
    min-height: 297mm;
    padding: 38px 44px;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }

  .green {
    color: #1B5E20;
  }

  .light-bg {
    background: #F1F8E9;
  }

  .dark-header {
    background: #1B5E20;
    color: white;
    padding: 30px 44px;
    margin: -38px -44px 30px;
  }

  .header-small {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: #F9A825;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .header-title {
    font-size: 34px;
    font-weight: 900;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 34px;
  }

  .company {
    font-size: 24px;
    font-weight: 900;
    color: #1B5E20;
  }

  .muted {
    color: #4A6741;
  }

  .hero {
    background: #1B5E20;
    color: white;
    margin: -38px -44px 0;
    padding: 46px 44px;
    min-height: 300px;
  }

  .hero h1 {
    font-size: 52px;
    line-height: 1.05;
    margin-top: 32px;
  }

  .hero .accent {
    color: #F9A825;
  }

  .hero-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 26px;
    margin-top: 34px;
    align-items: stretch;
  }

  .hero-img {
    width: 100%;
    height: 300px;
    object-fit: cover;
    border: 4px solid #8BC34A;
    border-radius: 20px;
  }

  .white-card {
    background: white;
    border: 2px solid #C8E6C9;
    border-radius: 16px;
    padding: 22px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin: 26px 0;
  }

  .stat {
    background: white;
    border: 2px solid #C8E6C9;
    border-radius: 14px;
    padding: 16px;
    text-align: center;
  }

  .stat .label {
    font-size: 10px;
    text-transform: uppercase;
    color: #4A6741;
    font-weight: 700;
    letter-spacing: 1px;
  }

  .stat .value {
    font-size: 22px;
    font-weight: 900;
    color: #1B5E20;
    margin-top: 6px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    background: #1B5E20;
    color: white;
    padding: 12px;
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  td {
    padding: 11px 12px;
    border-bottom: 1px solid #C8E6C9;
    font-size: 12px;
  }

  tr:nth-child(even) td {
    background: #F1F8E9;
  }

  .big-price {
    font-size: 42px;
    font-weight: 900;
    color: #1B5E20;
  }

  .project-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
    margin-top: 24px;
  }

  .project-card {
    background: white;
    border: 2px solid #C8E6C9;
    border-radius: 16px;
    overflow: hidden;
    min-height: 340px;
  }

  .project-card img {
    width: 100%;
    height: 170px;
    object-fit: cover;
    display: block;
  }

  .project-placeholder {
    height: 170px;
    background: linear-gradient(135deg, #1B5E20, #2E7D32);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
  }

  .project-body {
    padding: 16px;
  }

  .project-body h3 {
    color: #1B5E20;
    font-size: 17px;
    margin-bottom: 8px;
  }

  .project-body p {
    font-size: 11px;
    color: #4A6741;
    margin-bottom: 5px;
  }

  .quote {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #C8E6C9;
    font-style: italic;
  }

  .footer {
    position: absolute;
    bottom: 28px;
    left: 44px;
    right: 44px;
    border-top: 1px solid #C8E6C9;
    padding-top: 10px;
    font-size: 10px;
    color: #4A6741;
    display: flex;
    justify-content: space-between;
  }

  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }

  .note {
    background: #FFF8E1;
    border: 2px solid #F9A825;
    border-radius: 14px;
    padding: 16px;
    color: #4A6741;
    font-size: 13px;
    line-height: 1.6;
  }
</style>
</head>

<body>

<div class="page light-bg">
  <div class="topbar">
    <div>
      <div class="company">${companyName}</div>
      <div class="muted">${safeText(installer.tagline, 'Solar EPC & Rooftop Solutions')}</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#4A6741;line-height:1.6;">
      <div><b>Proposal:</b> ${proposalNo}</div>
      <div><b>Date:</b> ${today}</div>
      <div><b>Valid Until:</b> ${validDate}</div>
    </div>
  </div>

  <div class="hero">
    <div class="header-small">Customer Solar Proposal</div>
    <h1>Clean Energy<br><span class="accent">For Your Roof</span></h1>
    <p style="margin-top:18px;font-size:16px;line-height:1.6;max-width:560px;">
      Custom rooftop solar proposal prepared for ${customerName}.
    </p>
  </div>

  <div class="hero-grid">
    <div class="white-card">
      <div class="header-small" style="color:#1B5E20;">Prepared For</div>
      <h2>${customerName}</h2>
      <p class="muted" style="margin-top:8px;line-height:1.5;">${customerAddress}</p>
      <div style="margin-top:22px;font-size:18px;">
        <b class="green">System Size:</b> ${fin.systemKw} kW
      </div>
      <div style="margin-top:10px;font-size:18px;">
        <b class="green">Net Payable:</b> ${money(fin.netCost)}
      </div>
    </div>

    <div>
      ${aiImageSrc ? `<img class="hero-img" src="${aiImageSrc}" />` : `<div class="white-card">AI image not available</div>`}
    </div>
  </div>

  <div class="footer">
    <span>${companyName}</span>
    <span>${companyPhone}</span>
  </div>
</div>

<div class="page light-bg">
  <div class="dark-header">
    <div class="header-small">Financial Overview</div>
    <div class="header-title">Savings & Payback</div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="label">System Cost</div>
      <div class="value">${money(fin.quotedPrice)}</div>
    </div>

    <div class="stat">
      <div class="label">Subsidy</div>
      <div class="value">${money(fin.subsidyAmount)}</div>
    </div>

    <div class="stat">
      <div class="label">Net Payable</div>
      <div class="value">${money(fin.netCost)}</div>
    </div>

    <div class="stat">
      <div class="label">Payback</div>
      <div class="value">${fin.payback} yrs</div>
    </div>
  </div>

  <div class="two-col">
    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Savings Projection</h2>
      <table>
        <tbody>
          <tr><td>Annual Generation</td><td style="text-align:right;font-weight:900;">${fin.yearlyKwh.toLocaleString('en-IN')} kWh</td></tr>
          <tr><td>Current Monthly Bill</td><td style="text-align:right;font-weight:900;">${money(fin.monthlyBefore)}</td></tr>
          <tr><td>Estimated Monthly Bill After Solar</td><td style="text-align:right;font-weight:900;">${money(fin.monthlyAfter)}</td></tr>
          <tr><td>Annual Savings</td><td style="text-align:right;font-weight:900;">${money(fin.annualSaving)}</td></tr>
          <tr><td>25-Year Gross Savings</td><td style="text-align:right;font-weight:900;">${money(fin.annualSaving * 25)}</td></tr>
          <tr><td>25-Year Net Profit</td><td style="text-align:right;font-weight:900;">${money(fin.saving25yr)}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Environmental Impact</h2>
      <div class="stat" style="margin-bottom:14px;">
        <div class="label">CO₂ Offset</div>
        <div class="value">${fin.co2} Tons / Year</div>
      </div>
      <div class="stat">
        <div class="label">Equivalent Trees</div>
        <div class="value">${fin.trees} Trees / Year</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <span>${proposalNo}</span>
    <span>Financial estimates are indicative and subject to site verification.</span>
  </div>
</div>

<div class="page light-bg">
  <div class="dark-header">
    <div class="header-small">Technical Details</div>
    <div class="header-title">System Design & BOM</div>
  </div>

  <div class="white-card" style="margin-bottom:24px;">
    <h2 class="green" style="margin-bottom:14px;">System Specification</h2>
    <table>
      <tbody>
        <tr><td>System Type</td><td><b>On-Grid Rooftop Solar PV System</b></td></tr>
        <tr><td>System Size</td><td><b>${fin.systemKw} kW</b></td></tr>
        <tr><td>Solar Panels</td><td><b>${panelCount} Nos ${safeText(panelBrand)} Panels</b></td></tr>
        <tr><td>Inverter</td><td><b>${safeText(inverterBrand)} String Inverter</b></td></tr>
        <tr><td>Mounting Structure</td><td><b>GI/MS rooftop structure as per site condition</b></td></tr>
        <tr><td>Estimated Annual Generation</td><td><b>${fin.yearlyKwh.toLocaleString('en-IN')} kWh</b></td></tr>
      </tbody>
    </table>
  </div>

  <div class="white-card">
    <h2 class="green" style="margin-bottom:14px;">Bill of Materials</h2>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Specification</th>
          <th>Qty</th>
          <th>Warranty</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>Solar Panel</td><td>${safeText(panelBrand)} Mono PERC / TopCon</td><td>${panelCount} Nos</td><td>25 Years Performance</td></tr>
        <tr><td>Inverter</td><td>${safeText(inverterBrand)} Grid-Tie Inverter</td><td>1 No</td><td>5-10 Years</td></tr>
        <tr><td>Structure</td><td>GI/MS Mounting Structure</td><td>1 Set</td><td>As per vendor</td></tr>
        <tr><td>DC Cable</td><td>Solar DC Cable with MC4</td><td>As required</td><td>As per vendor</td></tr>
        <tr><td>AC/DC DB</td><td>Protection Box with SPD/MCB</td><td>1 Set</td><td>As per vendor</td></tr>
        <tr><td>Earthing + LA</td><td>Earthing and Lightning Protection</td><td>1 Set</td><td>As per vendor</td></tr>
        <tr><td>Net Meter</td><td>DISCOM-approved bidirectional meter</td><td>1 No</td><td>As per DISCOM</td></tr>
      </tbody>
    </table>
  </div>

  <div class="footer">
    <span>${companyName}</span>
    <span>${companyEmail}</span>
  </div>
</div>

<div class="page light-bg">
  <div class="dark-header">
    <div class="header-small">Costing</div>
    <div class="header-title">Price Calculation Breakup</div>
  </div>

  <div class="two-col">
    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Installer Cost Breakup</h2>
      <table>
        <tbody>
          ${costRow('Panel Cost', cb.panelCost)}
          ${costRow('Inverter Cost', cb.inverterCost)}
          ${costRow('Structure Cost', cb.structureCost)}
          ${costRow('Height Extra', cb.heightExtra)}
          ${costRow('Cable Cost', cb.cableCost)}
          ${costRow('Labour Cost', cb.labourCost)}
          ${costRow('AC/DC DB Cost', cb.acDcBoxCost)}
          ${costRow('Earthing + LA Cost', cb.earthingLaCost)}
          ${costRow('Net Metering Cost', cb.netMeteringCost)}
          ${costRow('Transport Cost', cb.transportCost)}
          ${costRow('Miscellaneous Cost', cb.miscCost)}
          ${costRow('Base Cost', cb.baseCost, true)}
          ${costRow('GST Amount', cb.gstAmount)}
          ${costRow('Installer Total Cost', cb.installerCost, true)}
        </tbody>
      </table>
    </div>

    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Customer Quotation</h2>
      <table>
        <tbody>
          ${costRow('Suggested Quote', fin.suggestedQuote)}
          ${costRow('Final Quote', fin.quotedPrice, true)}
          ${costRow('Estimated Installer Cost', fin.installerCost)}
          ${costRow('Estimated Margin', fin.estimatedMargin, true)}
          <tr><td>Margin %</td><td style="text-align:right;font-weight:900;">${fin.estimatedMarginPct}%</td></tr>
          ${costRow('Government Subsidy', fin.subsidyAmount)}
          ${costRow('Net Customer Payable', fin.netCost, true)}
        </tbody>
      </table>

      <div class="note" style="margin-top:20px;">
        This costing is generated from installer-defined rate master and site inputs.
        Final price is subject to physical site verification, stock availability, DISCOM approval, and customer requirements.
      </div>
    </div>
  </div>

  <div class="footer">
    <span>Private costing included for installer review</span>
    <span>${proposalNo}</span>
  </div>
</div>

<div class="page light-bg">
  <div class="dark-header">
    <div class="header-small">Commercials</div>
    <div class="header-title">Payment Terms & Next Steps</div>
  </div>

  <div class="white-card" style="margin-bottom:24px;">
    <h2 class="green" style="margin-bottom:14px;">Final Quotation</h2>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span style="font-size:18px;">Total System Cost</span>
      <span class="big-price">${money(fin.quotedPrice)}</span>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span style="font-size:18px;">Subsidy</span>
      <span style="font-size:28px;font-weight:900;color:#2E7D32;">${money(fin.subsidyAmount)}</span>
    </div>

    <div style="background:#E8F5E9;border:2px solid #8BC34A;border-radius:14px;padding:18px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:20px;font-weight:900;color:#1B5E20;">Net Customer Payable</span>
      <span class="big-price">${money(fin.netCost)}</span>
    </div>
  </div>

  <div class="white-card" style="margin-bottom:24px;">
    <h2 class="green" style="margin-bottom:14px;">Payment Milestones</h2>
    <table>
      <thead>
        <tr>
          <th>Milestone</th>
          <th>Timeline</th>
          <th style="text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>20% Advance</td><td>On confirmation</td><td style="text-align:right;font-weight:900;">${money(fin.advance)}</td></tr>
        <tr><td>70% Material Payment</td><td>Before delivery</td><td style="text-align:right;font-weight:900;">${money(fin.material)}</td></tr>
        <tr><td>10% Final Payment</td><td>After commissioning</td><td style="text-align:right;font-weight:900;">${money(fin.final)}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="two-col">
    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Bank Details</h2>
      <p><b>Bank:</b> ${safeText(installer.bank_name, 'Not provided')}</p>
      <p><b>Account:</b> ${safeText(installer.account_no, 'Not provided')}</p>
      <p><b>IFSC:</b> ${safeText(installer.ifsc, 'Not provided')}</p>
      <p><b>UPI:</b> ${safeText(installer.upi, 'Not provided')}</p>
    </div>

    <div class="white-card">
      <h2 class="green" style="margin-bottom:14px;">Contact</h2>
      <p><b>Phone:</b> ${companyPhone}</p>
      <p><b>Email:</b> ${companyEmail}</p>
      <p><b>Website:</b> ${companyWebsite}</p>
      <p><b>GST:</b> ${companyGst}</p>
    </div>
  </div>

  <div style="margin-top:34px;display:flex;justify-content:space-between;">
    <div style="width:38%;text-align:center;border-top:2px solid #1B5E20;padding-top:12px;">
      <b>${customerName}</b>
      <div style="font-size:10px;color:#4A6741;margin-top:4px;">Customer Acceptance</div>
    </div>

    <div style="width:38%;text-align:center;border-top:2px solid #1B5E20;padding-top:12px;">
      <b>${companyName}</b>
      <div style="font-size:10px;color:#4A6741;margin-top:4px;">Authorized Signatory</div>
    </div>
  </div>

  <div class="footer">
    <span>${companyName}</span>
    <span>Powered by SolarQuote</span>
  </div>
</div>

${projectCards ? `
<div class="page light-bg">
  <div class="dark-header">
    <div class="header-small">Trust Proof</div>
    <div class="header-title">Past Projects</div>
  </div>

  <div class="project-grid">
    ${projectCards}
  </div>

  <div class="footer">
    <span>${companyName}</span>
    <span>Past project details shared by installer</span>
  </div>
</div>
` : ''}

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
