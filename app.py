import os
import uuid
import json
import base64
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from PIL import Image
import io
from openai import OpenAI
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Image as RLImage, Table, TableStyle, Paragraph, Spacer, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from datetime import datetime

app = Flask(__name__, static_folder='static', static_url_path='')
CORS(app, origins="*")

UPLOAD_DIR = "/tmp/solar_quotes"
os.makedirs(UPLOAD_DIR, exist_ok=True)

def get_client():
    return OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

def build_prompt(panel_count, roof_type, mounting_type):
    roof_map = {
        "flat_rcc":    "flat grey reinforced concrete rooftop of an Indian residential building",
        "sloped_tile": "sloped clay tile roof of an Indian house",
        "metal_sheet": "corrugated metal sheet industrial roof",
        "flat_terrace":"flat concrete terrace rooftop",
    }
    mount_map = {
        "ground_mount": "elevated aluminum mounting structures tilted at 17 degrees facing south, galvanized steel racking system, panels raised 30cm above roof surface",
        "flush_mount":  "flush mounted low profile aluminum rails close to roof surface",
        "ballast":      "ballast mounted on weighted concrete blocks tilted at 15 degrees no drilling",
    }
    roof  = roof_map.get(roof_type,  "flat grey concrete rooftop")
    mount = mount_map.get(mounting_type, "elevated mounting structures tilted 17 degrees")
    return (
        f"photorealistic photograph of {panel_count} solar panels "
        f"professionally installed on {roof}, "
        f"{mount}, "
        f"dark blue monocrystalline solar panels with silver aluminum frames, "
        f"photovoltaic cell grid pattern clearly visible, "
        f"DC cables running along mounting rails, "
        f"string inverter mounted on wall, "
        f"bright Indian daylight with sharp shadows, "
        f"high resolution DSLR photography, "
        f"8K photorealistic real photograph"
    )

def polygon_to_mask(polygon_points, image_size):
    import numpy as np
    try:
        import cv2
        w, h = image_size
        mask_rgba = np.ones((h, w, 4), dtype=np.uint8) * 255
        if len(polygon_points) >= 3:
            fill = np.zeros((h, w), dtype=np.uint8)
            pts  = np.array(
                [[int(p["x"]), int(p["y"])] for p in polygon_points],
                dtype=np.int32
            )
            cv2.fillPoly(fill, [pts], 255)
            fill = cv2.GaussianBlur(fill, (21, 21), 0)
            mask_rgba[:, :, 3] = 255 - fill
        return Image.fromarray(mask_rgba, "RGBA")
    except:
        w, h = image_size
        mask = Image.new("RGBA", (w, h), (255, 255, 255, 255))
        if len(polygon_points) >= 3:
            from PIL import ImageDraw
            draw = ImageDraw.Draw(mask)
            pts  = [(int(p["x"]), int(p["y"])) for p in polygon_points]
            draw.polygon(pts, fill=(255, 255, 255, 0))
        return mask

def calculate_financials(panel_count, system_kw, monthly_bill):
    total_cost     = system_kw * 65000
    subsidy        = 78000 if system_kw >= 3 else (60000 if system_kw >= 2 else 30000)
    net_cost       = total_cost - subsidy
    yearly_kwh     = system_kw * 1500
    unit_rate      = max(6, min((monthly_bill * 12) / max(yearly_kwh, 1), 12))
    annual_savings = yearly_kwh * unit_rate
    payback        = net_cost / max(annual_savings, 1)
    savings_25yr   = (annual_savings * 25) - net_cost
    return {
        "panel_count":    panel_count,
        "system_kw":      round(system_kw, 1),
        "total_cost":     round(total_cost),
        "subsidy":        subsidy,
        "net_cost":       round(net_cost),
        "yearly_kwh":     round(yearly_kwh),
        "annual_savings": round(annual_savings),
        "payback_years":  round(payback, 1),
        "savings_25yr":   round(savings_25yr),
    }

def generate_pdf(image_path, fin, installer, homeowner, output_path,
                 installer_phone="", installer_email="",
                 panel_brand="Waaree / Adani Solar",
                 inverter_brand="Solis / Growatt"):

    doc    = SimpleDocTemplate(output_path, pagesize=A4,
                rightMargin=1.5*cm, leftMargin=1.5*cm,
                topMargin=1.5*cm,   bottomMargin=1.5*cm)
    styles = getSampleStyleSheet()
    story  = []

    # ── COLOURS ───────────────────────────────────────────────────────────────
    DARK_BLUE  = colors.HexColor("#1a3a5c")
    GREEN      = colors.HexColor("#2d6a2d")
    LIGHT_BLUE = colors.HexColor("#EBF3FB")
    WHITE      = colors.white

    def h1(text):
        return Paragraph(f"<b>{text}</b>",
            ParagraphStyle("h1", parent=styles["Title"], fontSize=22,
                textColor=DARK_BLUE, alignment=TA_CENTER, spaceAfter=4))

    def h2(text):
        return Paragraph(f"<b>{text}</b>",
            ParagraphStyle("h2", parent=styles["Normal"], fontSize=14,
                textColor=DARK_BLUE, spaceAfter=6, spaceBefore=10))

    def body(text):
        return Paragraph(text,
            ParagraphStyle("body", parent=styles["Normal"], fontSize=10,
                textColor=colors.HexColor("#333333"), spaceAfter=6,
                leading=16))

    def small(text):
        return Paragraph(text,
            ParagraphStyle("small", parent=styles["Normal"], fontSize=8,
                textColor=colors.grey, alignment=TA_CENTER))

    def section_header(text, bg=DARK_BLUE):
        t = Table([[text]], colWidths=[17*cm])
        t.setStyle(TableStyle([
            ("BACKGROUND",    (0,0), (-1,-1), bg),
            ("TEXTCOLOR",     (0,0), (-1,-1), WHITE),
            ("FONTNAME",      (0,0), (-1,-1), "Helvetica-Bold"),
            ("FONTSIZE",      (0,0), (-1,-1), 12),
            ("ALIGN",         (0,0), (-1,-1), "CENTER"),
            ("TOPPADDING",    (0,0), (-1,-1), 8),
            ("BOTTOMPADDING", (0,0), (-1,-1), 8),
        ]))
        return t

    today = datetime.today().strftime("%d %b %Y")

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 1 — COVER PAGE
    # ════════════════════════════════════════════════════════════════════════
    story.append(Spacer(1, 1*cm))
    story.append(h1("☀  Solar Energy Proposal"))
    story.append(Spacer(1, 0.3*cm))
    story.append(HRFlowable(width="100%", thickness=3, color=DARK_BLUE))
    story.append(Spacer(1, 0.5*cm))

    cover_data = [
        ["Prepared For",  homeowner],
        ["Prepared By",   installer],
        ["Contact",       installer_phone or "—"],
        ["Email",         installer_email or "—"],
        ["Proposal Date", today],
        ["Valid Until",   (datetime.today().replace(day=28)).strftime("%d %b %Y")],
    ]
    ct = Table(cover_data, colWidths=[5*cm, 12*cm])
    ct.setStyle(TableStyle([
        ("FONTNAME",      (0,0), (0,-1), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,-1), 11),
        ("TEXTCOLOR",     (0,0), (0,-1), DARK_BLUE),
        ("ROWBACKGROUNDS",(0,0), (-1,-1), [LIGHT_BLUE, WHITE]),
        ("TOPPADDING",    (0,0), (-1,-1), 7),
        ("BOTTOMPADDING", (0,0), (-1,-1), 7),
        ("GRID",          (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
    ]))
    story.append(ct)
    story.append(Spacer(1, 0.5*cm))
    story.append(small(
        "This proposal is valid for 30 days from the date of issue. "
        "Prices are subject to change after the validity period."
    ))
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 2 — WELCOME LETTER
    # ════════════════════════════════════════════════════════════════════════
    story.append(h2("Dear " + homeowner + ","))
    story.append(Spacer(1, 0.3*cm))
    story.append(body(
        f"Thank you for considering <b>{installer}</b> for your solar installation. "
        f"We are delighted to present this customised solar energy proposal, "
        f"designed specifically for your property."
    ))
    story.append(body(
        f"Based on our assessment, we recommend a <b>{fin['system_kw']} kW on-grid solar system</b> "
        f"consisting of <b>{fin['panel_count']} high-efficiency solar panels</b>. "
        f"This system is projected to generate approximately <b>{fin['yearly_kwh']:,} kWh of clean electricity per year</b>, "
        f"significantly reducing your dependence on grid power."
    ))
    story.append(body(
        f"With the <b>PM Surya Ghar Muft Bijli Yojana</b> subsidy of "
        f"<b>Rs {fin['subsidy']:,}</b>, your net investment comes down to just "
        f"<b>Rs {fin['net_cost']:,}</b>. At your current electricity consumption, "
        f"you will recover this investment in approximately <b>{fin['payback_years']} years</b> "
        f"and save an estimated <b>Rs {fin['savings_25yr']:,} over 25 years</b>."
    ))
    story.append(body(
        "We are committed to delivering a safe, high-quality installation using only "
        "certified components from leading Indian manufacturers. Our team handles "
        "everything from design and installation to subsidy paperwork and net metering."
    ))
    story.append(Spacer(1, 0.5*cm))
    story.append(body("Warm regards,"))
    story.append(Spacer(1, 0.2*cm))
    story.append(body(f"<b>{installer}</b>"))
    story.append(body(f"{installer_phone}"))
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 3 — SYSTEM OVERVIEW + AI IMAGE
    # ════════════════════════════════════════════════════════════════════════
    story.append(section_header("System Overview & Projected Savings"))
    story.append(Spacer(1, 0.4*cm))
    story.append(RLImage(image_path, width=17*cm, height=10*cm))
    story.append(Spacer(1, 0.4*cm))

    # Big bold savings numbers
    savings_data = [
        [f"{fin['system_kw']} kW",
         f"{fin['panel_count']} Panels",
         f"{fin['yearly_kwh']:,} kWh/yr"],
        ["System Size", "Panel Count", "Annual Generation"],
        [f"Rs {fin['net_cost']:,}",
         f"Rs {fin['annual_savings']:,}/yr",
         f"{fin['payback_years']} Years"],
        ["Net Investment", "Annual Savings", "Payback Period"],
    ]
    st = Table(savings_data, colWidths=[5.67*cm, 5.67*cm, 5.67*cm])
    st.setStyle(TableStyle([
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTNAME",      (0,2), (-1,2), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,0), 16),
        ("FONTSIZE",      (0,2), (-1,2), 16),
        ("FONTSIZE",      (0,1), (-1,1), 9),
        ("FONTSIZE",      (0,3), (-1,3), 9),
        ("TEXTCOLOR",     (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",     (0,2), (-1,2), GREEN),
        ("TEXTCOLOR",     (0,1), (-1,1), colors.grey),
        ("TEXTCOLOR",     (0,3), (-1,3), colors.grey),
        ("ALIGN",         (0,0), (-1,-1), "CENTER"),
        ("TOPPADDING",    (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
        ("LINEBELOW",     (0,1), (-1,1), 0.5, colors.HexColor("#CCDDEE")),
    ]))
    story.append(st)
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 4 — FINANCIAL DETAILS
    # ════════════════════════════════════════════════════════════════════════
    story.append(section_header("Detailed Financial Analysis"))
    story.append(Spacer(1, 0.4*cm))

    fin_data = [
        ["Financial Summary",              ""],
        ["Total System Cost",              f"Rs {fin['total_cost']:,}"],
        ["PM Surya Ghar Subsidy",          f"- Rs {fin['subsidy']:,}"],
        ["Your Net Investment",            f"Rs {fin['net_cost']:,}"],
        ["Annual Energy Generation",       f"{fin['yearly_kwh']:,} kWh"],
        ["Annual Electricity Savings",     f"Rs {fin['annual_savings']:,}"],
        ["Payback Period",                 f"{fin['payback_years']} years"],
        ["25-Year Gross Savings",          f"Rs {fin['savings_25yr']:,}"],
        ["CO₂ Offset Per Year",            f"{round(fin['yearly_kwh']*0.82/1000,1)} tonnes"],
    ]
    ft = Table(fin_data, colWidths=[10*cm, 7*cm])
    ft.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("SPAN",           (0,0), (-1,0)),
        ("ALIGN",          (0,0), (-1,0), "CENTER"),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 12),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [LIGHT_BLUE, WHITE]),
        ("FONTSIZE",       (0,1), (-1,-1), 10),
        ("FONTNAME",       (0,3), (0,3),  "Helvetica-Bold"),
        ("TEXTCOLOR",      (1,3), (1,3),  GREEN),
        ("ALIGN",          (1,1), (1,-1), "RIGHT"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",     (0,0), (-1,-1), 7),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 7),
    ]))
    story.append(ft)
    story.append(Spacer(1, 0.5*cm))

    # Payment milestones
    story.append(h2("Payment Schedule"))
    pay_data = [
        ["Milestone",                           "Percentage", "Amount"],
        ["Advance (Booking Confirmation)",      "20%",        f"Rs {round(fin['net_cost']*0.20):,}"],
        ["Before Material Delivery",            "70%",        f"Rs {round(fin['net_cost']*0.70):,}"],
        ["After Commissioning & Handover",      "10%",        f"Rs {round(fin['net_cost']*0.10):,}"],
        ["Total",                               "100%",       f"Rs {fin['net_cost']:,}"],
    ]
    pt = Table(pay_data, colWidths=[9*cm, 3*cm, 5*cm])
    pt.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",     (0,0), (-1,0), WHITE),
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,0), 10),
        ("FONTNAME",      (0,4), (-1,4), "Helvetica-Bold"),
        ("BACKGROUND",    (0,4), (-1,4), LIGHT_BLUE),
        ("ROWBACKGROUNDS",(0,1), (-1,3), [WHITE, LIGHT_BLUE]),
        ("FONTSIZE",      (0,1), (-1,-1), 10),
        ("ALIGN",         (1,0), (-1,-1), "CENTER"),
        ("GRID",          (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",    (0,0), (-1,-1), 7),
        ("BOTTOMPADDING", (0,0), (-1,-1), 7),
    ]))
    story.append(pt)
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 5 — BILL OF MATERIALS
    # ════════════════════════════════════════════════════════════════════════
    story.append(section_header("Bill of Materials (BOM)"))
    story.append(Spacer(1, 0.4*cm))

    bom_data = [
        ["Component",       "Specification",                          "Qty",    "Warranty"],
        ["Solar Panels",
         f"{panel_brand} — {400}W Mono PERC Half-Cut",
         str(fin['panel_count']),
         "25 yr performance\n10 yr product"],
        ["Solar Inverter",
         f"{inverter_brand} — {fin['system_kw']} kW String Inverter\nWi-Fi monitoring included",
         "1",
         "10 years"],
        ["Mounting Structure",
         "Hot-dip galvanised steel 80 micron\nAdjustable tilt — MNRE approved",
         "1 set",
         "10 years"],
        ["DC Cables",
         "4mm² UV resistant solar cable\nMC4 connectors included",
         "As required",
         "10 years"],
        ["AC Distribution Box",
         "IP65 weatherproof enclosure\nWith SPD and MCB protection",
         "1",
         "2 years"],
        ["Net Meter",
         "Bidirectional energy meter\nDISCOM approved model",
         "1",
         "As per DISCOM"],
    ]
    bt = Table(bom_data, colWidths=[3.5*cm, 7.5*cm, 2*cm, 4*cm])
    bt.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 10),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [LIGHT_BLUE, WHITE]),
        ("FONTSIZE",       (0,1), (-1,-1), 9),
        ("FONTNAME",       (0,1), (0,-1), "Helvetica-Bold"),
        ("VALIGN",         (0,0), (-1,-1), "MIDDLE"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",     (0,0), (-1,-1), 7),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 7),
    ]))
    story.append(bt)
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 6 — TERMS AND CONDITIONS
    # ════════════════════════════════════════════════════════════════════════
    story.append(section_header("Terms and Conditions"))
    story.append(Spacer(1, 0.4*cm))

    tcs = [
        ("Scope of Work",
         "Supply, installation, testing and commissioning of the solar PV system as per "
         "the specifications mentioned in this proposal. Includes civil work for mounting "
         "structure and DC/AC cabling up to the main distribution board."),
        ("Exclusions",
         "Net metering application fees (paid to DISCOM), electrical upgrades to existing "
         "wiring beyond the scope of solar installation, and any structural reinforcement "
         "of the roof are not included unless explicitly stated."),
        ("Subsidy",
         "PM Surya Ghar subsidy is subject to government approval and DISCOM registration. "
         "Installer will assist with documentation but cannot guarantee subsidy timelines."),
        ("Warranty",
         "All equipment warranties are as per manufacturer terms. Installation workmanship "
         "is warranted for 1 year from commissioning date."),
        ("Site Conditions",
         "This proposal is based on the site assessment conducted. Any changes to roof "
         "structure, shading, or electrical conditions discovered during installation "
         "may affect the final system design and cost."),
        ("Validity",
         "This proposal is valid for 30 days from the date of issue. "
         "Prices are subject to revision after the validity period due to "
         "market fluctuations in panel and inverter pricing."),
        ("Dispute Resolution",
         "Any disputes arising from this contract shall be subject to the jurisdiction "
         "of courts in the city of installation."),
    ]

    for title, text in tcs:
        story.append(body(f"<b>{title}:</b> {text}"))
        story.append(Spacer(1, 0.1*cm))

    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # PAGE 7 — THANK YOU + ACCEPTANCE
    # ════════════════════════════════════════════════════════════════════════
    story.append(section_header("Thank You — Next Steps", bg=GREEN))
    story.append(Spacer(1, 0.5*cm))
    story.append(body(
        f"Dear <b>{homeowner}</b>, thank you for this opportunity. "
        "We look forward to powering your home with clean, affordable solar energy."
    ))
    story.append(Spacer(1, 0.3*cm))

    steps_data = [
        ["Step", "Action",                              "Timeline"],
        ["1",    "Pay 20% advance to confirm booking",  "Today"],
        ["2",    "Site survey and final design",        "Within 3 days"],
        ["3",    "Material procurement and delivery",   "7-10 days"],
        ["4",    "Installation and testing",            "1-2 days"],
        ["5",    "Net meter application filed",         "Post installation"],
        ["6",    "Subsidy disbursement",                "30-60 days"],
    ]
    nst = Table(steps_data, colWidths=[1.5*cm, 11*cm, 4.5*cm])
    nst.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), GREEN),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 10),
        ("ROWBACKGROUNDS", (0,1), (-1,-1),
         [colors.HexColor("#EBF5EB"), WHITE]),
        ("FONTSIZE",       (0,1), (-1,-1), 10),
        ("ALIGN",          (0,0), (-1,-1), "CENTER"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCEECC")),
        ("TOPPADDING",     (0,0), (-1,-1), 8),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 8),
    ]))
    story.append(nst)
    story.append(Spacer(1, 0.8*cm))

    # Signature block
    story.append(h2("Acceptance"))
    story.append(body(
        "By signing below, you confirm that you have read, understood, and agree "
        "to the terms of this proposal."
    ))
    story.append(Spacer(1, 0.5*cm))

    sig_data = [
        ["Customer Signature",          "Installer Representative"],
        ["",                            ""],
        [f"Name: {homeowner}",          f"Name: {installer}"],
        ["Date: _______________",       f"Date: {today}"],
    ]
    sigt = Table(sig_data, colWidths=[8.5*cm, 8.5*cm])
    sigt.setStyle(TableStyle([
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,-1), 10),
        ("TEXTCOLOR",     (0,0), (-1,0), DARK_BLUE),
        ("ROWHEIGHTS",    {1: 40}),
        ("BOX",           (0,0), (0,-1), 0.5, colors.grey),
        ("BOX",           (1,0), (1,-1), 0.5, colors.grey),
        ("TOPPADDING",    (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING",   (0,0), (-1,-1), 8),
    ]))
    story.append(sigt)
    story.append(Spacer(1, 0.5*cm))
    story.append(HRFlowable(width="100%", thickness=1, color=DARK_BLUE))
    story.append(Spacer(1, 0.2*cm))
    story.append(small(
        f"{installer}  |  {installer_phone}  |  {installer_email}  |  "
        "Powered by SolarQuote"
    ))

    doc.build(story)
    return output_path

@app.route("/api/generate-quote", methods=["POST"])
def generate_quote():
    job_id  = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    try:
        photo        = request.files["photo"]
        polygon      = json.loads(request.form["polygon"])
        panel_count  = int(request.form["panel_count"])
        system_kw    = float(request.form["system_kw"])
        roof_type    = request.form.get("roof_type", "flat_rcc")
        mounting     = request.form.get("mounting_type", "ground_mount")
        homeowner    = request.form.get("homeowner_name", "Homeowner")
        monthly_bill = int(request.form.get("monthly_bill", 3000))
        installer    = request.form.get("installer_name", "Solar Installer")

        # Save and compress photo
        photo_path = os.path.join(job_dir, "roof.png")
        img = Image.open(photo.stream).convert("RGB")
        img.thumbnail((1024, 1024), Image.LANCZOS)
        img.save(photo_path, "PNG")
        w, h = img.size

        # Create mask from polygon
        mask      = polygon_to_mask(polygon, (w, h))
        mask_path = os.path.join(job_dir, "mask.png")
        mask.save(mask_path, "PNG")

        # Build prompt
        prompt = build_prompt(panel_count, roof_type, mounting)

        # Call OpenAI
        client = get_client()
        with open(photo_path, "rb") as img_f, open(mask_path, "rb") as mask_f:
            response = client.images.edit(
                model  = "gpt-image-1",
                image  = img_f,
                mask   = mask_f,
                prompt = prompt,
                n      = 1,
                size   = "1024x1024",
            )

        image_bytes = base64.b64decode(response.data[0].b64_json)
        result_path = os.path.join(job_dir, "result.jpg")
        result_img  = Image.open(io.BytesIO(image_bytes))
        result_img.save(result_path, "JPEG", quality=90)

        fin      = calculate_financials(panel_count, system_kw, monthly_bill)
        pdf_path = os.path.join(job_dir, "proposal.pdf")
        generate_pdf(
    result_path, fin, installer, homeowner, pdf_path,
    installer_phone=request.form.get("installer_phone", ""),
    installer_email=request.form.get("installer_email", ""),
    panel_brand=request.form.get("panel_brand", "Waaree / Adani Solar"),
    inverter_brand=request.form.get("inverter_brand", "Solis / Growatt"),
)

        return jsonify({
            "job_id":     job_id,
            "image_url":  f"/output/{job_id}/result.jpg",
            "pdf_url":    f"/output/{job_id}/proposal.pdf",
            "financials": fin,
        })

    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route("/output/<job_id>/<filename>")
def serve_output(job_id, filename):
    path = os.path.join(UPLOAD_DIR, job_id, filename)
    return send_file(path)

@app.route("/")
def index():
    return app.send_static_file("index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
