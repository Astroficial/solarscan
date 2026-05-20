import os
import uuid
import json
import base64
import io
import math
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Image as RLImage, Table, TableStyle,
    Paragraph, Spacer, HRFlowable, PageBreak
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from datetime import datetime
from openai import OpenAI

app = Flask(__name__, static_folder='static', static_url_path='')
CORS(app, origins="*")

UPLOAD_DIR = "/tmp/solar_quotes"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── PANEL LAYOUT CALCULATION ──────────────────────────────────────────────────
def get_panel_layout(panel_count):
    if panel_count <= 12:
        return {"rows": 2, "cols": math.ceil(panel_count / 2)}
    elif panel_count <= 21:
        return {"rows": 3, "cols": math.ceil(panel_count / 3)}
    else:
        return {"rows": 4, "cols": math.ceil(panel_count / 4)}

# ── DYNAMIC PROMPT BUILDER ────────────────────────────────────────────────────
def build_prompt(system_kw, panel_count, panel_watt, leg_heights_ft, roof_type):

    layout = get_panel_layout(panel_count)

    # Average leg height from engineer markings
    avg_leg_ft = round(sum(leg_heights_ft) / len(leg_heights_ft), 1) if leg_heights_ft else 3.0
    max_leg_ft = max(leg_heights_ft) if leg_heights_ft else 3.0

    roof_descriptions = {
        "flat_rcc":     "flat reinforced concrete Indian residential rooftop",
        "sloped_tile":  "sloped clay tile roof Indian house",
        "metal_sheet":  "corrugated metal sheet industrial roof",
        "flat_terrace": "flat concrete terrace rooftop",
    }
    roof_desc = roof_descriptions.get(roof_type, "flat concrete Indian rooftop")

    prompt = f"""Edit the uploaded actual roof photograph by installing a realistic Indian rooftop solar panel system inside the marked yellow polygon area.

The yellow polygon shows the exact panel plane selected by the engineer.

Install a {system_kw} kW rooftop solar system using exactly {panel_count} separate solar panels arranged in {layout_rows} rows × {layout_columns} columns.

Every panel must be clearly separate and countable. Each panel must have its own visible aluminum frame, clear gap from adjacent panels, and realistic blue photovoltaic cell texture. Do not merge panels into one large sheet.

Mount the panels on realistic elevated Indian rooftop GI/MS support structure with visible rails, braces, clamps, cross members, and RCC concrete pedestal blocks.

Support marking rule:
If red support guide lines or blue footing marks are visible in the image, use them as the exact guidance for extended support rods. Extend realistic GI/MS support rods from the solar panel frame down to the marked roof footing points. Place RCC concrete blocks at the blue footing marks. The panels must not appear floating.

If the panel polygon is visually higher than the roof surface, automatically add long support rods down to the nearest visible rooftop surface and place RCC concrete footing blocks below them.

Orientation rule:
The panels should appear south-facing according to the engineer’s camera angle. If the photo is taken from the south side facing north, show the front face of the solar panels toward the camera.

Preserve the original roof photo completely:
- do not change roof geometry
- do not change parapet walls
- do not change vents, tanks, AC units, pipes, trees, towers, buildings, sky, or background
- do not distort the original camera perspective
- do not remove stains, cracks, weathering, or rooftop texture

Lighting and shadows:
- match the original sunlight direction
- add realistic shadows under panels, support rods, frames, and RCC blocks
- shadows must fall naturally on the roof surface
- panel reflections should be subtle, not mirror-like

Electrical details:
- add subtle DC cable routing under the panels
- add one small inverter or junction box near a wall/parapet only if it fits naturally
- keep wiring minimal and realistic

Final output:
A realistic Indian rooftop solar EPC proposal image showing exactly {panel_count} separate panels installed inside the marked polygon, with extended support rods and RCC footing blocks wherever marked.

Strict negative instructions:
- do not create one continuous solar sheet
- do not merge panels
- do not change exact panel count
- do not ignore red support guide lines
- do not ignore blue footing marks
- do not create floating panels
- do not paste another image
- do not distort roof/background
- do not add unrelated objects
"""

    return prompt

# ── FINANCIALS ────────────────────────────────────────────────────────────────
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

# ── PDF GENERATION ────────────────────────────────────────────────────────────
def generate_pdf(image_path, fin, installer, homeowner, output_path,
                 installer_phone="", installer_email="",
                 panel_brand="Waaree Solar", inverter_brand="Solis"):

    doc    = SimpleDocTemplate(output_path, pagesize=A4,
                rightMargin=1.5*cm, leftMargin=1.5*cm,
                topMargin=1.5*cm,   bottomMargin=1.5*cm)
    styles = getSampleStyleSheet()
    story  = []

    DARK_BLUE  = colors.HexColor("#1a3a5c")
    GREEN      = colors.HexColor("#2d6a2d")
    LIGHT_BLUE = colors.HexColor("#EBF3FB")
    WHITE      = colors.white
    today      = datetime.today().strftime("%d %b %Y")

    def h1(text):
        return Paragraph(f"<b>{text}</b>",
            ParagraphStyle("h1", parent=styles["Title"], fontSize=22,
                textColor=DARK_BLUE, alignment=TA_CENTER, spaceAfter=4))

    def h2(text):
        return Paragraph(f"<b>{text}</b>",
            ParagraphStyle("h2", parent=styles["Normal"], fontSize=13,
                textColor=DARK_BLUE, spaceAfter=6, spaceBefore=8))

    def body(text):
        return Paragraph(text,
            ParagraphStyle("body", parent=styles["Normal"], fontSize=10,
                textColor=colors.HexColor("#333333"),
                spaceAfter=5, leading=15))

    def small(text):
        return Paragraph(text,
            ParagraphStyle("sm", parent=styles["Normal"], fontSize=7,
                textColor=colors.grey, alignment=TA_CENTER))

    def sec(text, bg=DARK_BLUE):
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

    # PAGE 1 — COVER
    story.append(Spacer(1, 0.8*cm))
    story.append(h1("☀  Solar Energy Proposal"))
    story.append(Spacer(1, 0.3*cm))
    story.append(HRFlowable(width="100%", thickness=3, color=DARK_BLUE))
    story.append(Spacer(1, 0.5*cm))
    cover = [
        ["Prepared For",  homeowner],
        ["Prepared By",   installer],
        ["Contact",       installer_phone or "—"],
        ["Email",         installer_email or "—"],
        ["Date",          today],
        ["Valid Until",   "30 days from above date"],
    ]
    ct = Table(cover, colWidths=[5*cm, 12*cm])
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
    story.append(PageBreak())

    # PAGE 2 — WELCOME
    story.append(h2(f"Dear {homeowner},"))
    story.append(Spacer(1, 0.2*cm))
    story.append(body(
        f"Thank you for considering <b>{installer}</b> for your solar installation. "
        f"We present this customised proposal for a "
        f"<b>{fin['system_kw']} kW on-grid solar system</b> with "
        f"<b>{fin['panel_count']} high-efficiency panels</b> "
        f"facing true south for maximum generation."
    ))
    story.append(body(
        f"This system will generate approximately <b>{fin['yearly_kwh']:,} kWh per year</b>, "
        f"saving you <b>Rs {fin['annual_savings']:,} annually</b>. "
        f"With the PM Surya Ghar subsidy of <b>Rs {fin['subsidy']:,}</b>, "
        f"your net investment is just <b>Rs {fin['net_cost']:,}</b> "
        f"with a payback of <b>{fin['payback_years']} years</b>."
    ))
    story.append(body(
        "Our team handles everything from design and installation "
        "to subsidy paperwork and net metering registration."
    ))
    story.append(Spacer(1, 0.4*cm))
    story.append(body(f"Warm regards,<br/><b>{installer}</b><br/>{installer_phone}"))
    story.append(PageBreak())

    # PAGE 3 — AI GENERATED IMAGE
    story.append(sec("Your Roof — Solar Installation Preview"))
    story.append(Spacer(1, 0.3*cm))
    story.append(body(
        "The image below shows your actual roof with the proposed solar installation. "
        "Panels are oriented <b>true south at 25-30 degree tilt</b> on elevated "
        "GI/MS mounting structure for maximum annual energy generation."
    ))
    story.append(Spacer(1, 0.2*cm))
    story.append(RLImage(image_path, width=17*cm, height=11*cm))
    story.append(Spacer(1, 0.3*cm))

    # Key numbers
    kn = [[
        f"{fin['system_kw']} kW",
        f"Rs {fin['net_cost']:,}",
        f"Rs {fin['annual_savings']:,}/yr",
        f"{fin['payback_years']} yrs"
    ],[
        "System Size", "Net Investment", "Annual Savings", "Payback"
    ]]
    knt = Table(kn, colWidths=[4.25*cm]*4)
    knt.setStyle(TableStyle([
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,0), 14),
        ("FONTSIZE",      (0,1), (-1,1), 9),
        ("TEXTCOLOR",     (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",     (0,1), (-1,1), colors.grey),
        ("ALIGN",         (0,0), (-1,-1), "CENTER"),
        ("TOPPADDING",    (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    story.append(knt)
    story.append(PageBreak())

    # PAGE 4 — FINANCIAL + PAYMENT
    story.append(sec("Financial Analysis"))
    story.append(Spacer(1, 0.3*cm))
    fin_data = [
        ["Financial Summary",          ""],
        ["Total System Cost",          f"Rs {fin['total_cost']:,}"],
        ["PM Surya Ghar Subsidy",      f"- Rs {fin['subsidy']:,}"],
        ["Your Net Investment",        f"Rs {fin['net_cost']:,}"],
        ["Annual Energy Generation",   f"{fin['yearly_kwh']:,} kWh"],
        ["Annual Electricity Savings", f"Rs {fin['annual_savings']:,}"],
        ["Payback Period",             f"{fin['payback_years']} years"],
        ["25-Year Net Savings",        f"Rs {fin['savings_25yr']:,}"],
        ["CO2 Offset Per Year",        f"{round(fin['yearly_kwh']*0.82/1000,1)} tonnes"],
    ]
    ft = Table(fin_data, colWidths=[10*cm, 7*cm])
    ft.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("SPAN",           (0,0), (-1,0)),
        ("ALIGN",          (0,0), (-1,0), "CENTER"),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 11),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [LIGHT_BLUE, WHITE]),
        ("FONTSIZE",       (0,1), (-1,-1), 10),
        ("FONTNAME",       (0,3), (0,3),  "Helvetica-Bold"),
        ("TEXTCOLOR",      (1,3), (1,3),  GREEN),
        ("ALIGN",          (1,1), (1,-1), "RIGHT"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",     (0,0), (-1,-1), 6),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 6),
    ]))
    story.append(ft)
    story.append(Spacer(1, 0.4*cm))

    story.append(h2("Payment Schedule"))
    pay_data = [
        ["Milestone",                      "Percentage", "Amount"],
        ["Advance — Booking Confirmation", "20%",  f"Rs {round(fin['net_cost']*0.20):,}"],
        ["Before Material Delivery",       "70%",  f"Rs {round(fin['net_cost']*0.70):,}"],
        ["After Commissioning",            "10%",  f"Rs {round(fin['net_cost']*0.10):,}"],
        ["Total",                          "100%", f"Rs {fin['net_cost']:,}"],
    ]
    pt = Table(pay_data, colWidths=[9*cm, 3*cm, 5*cm])
    pt.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,0), DARK_BLUE),
        ("TEXTCOLOR",     (0,0), (-1,0), WHITE),
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTNAME",      (0,4), (-1,4), "Helvetica-Bold"),
        ("BACKGROUND",    (0,4), (-1,4), LIGHT_BLUE),
        ("ROWBACKGROUNDS",(0,1), (-1,3), [WHITE, LIGHT_BLUE]),
        ("FONTSIZE",      (0,0), (-1,-1), 10),
        ("ALIGN",         (1,0), (-1,-1), "CENTER"),
        ("GRID",          (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",    (0,0), (-1,-1), 7),
        ("BOTTOMPADDING", (0,0), (-1,-1), 7),
    ]))
    story.append(pt)
    story.append(PageBreak())

    # PAGE 5 — BOM
    story.append(sec("Bill of Materials"))
    story.append(Spacer(1, 0.3*cm))
    bom_data = [
        ["Component",     "Specification",                                    "Qty",    "Warranty"],
        ["Solar Panels",  f"{panel_brand} 400W Mono PERC Half-Cut",          str(fin['panel_count']), "25yr perf\n10yr product"],
        ["Inverter",      f"{inverter_brand} {fin['system_kw']}kW\nWi-Fi monitoring", "1", "10 years"],
        ["Structure",     "GI/MS raised mounting 25-30deg\nMNRE approved",   "1 set",  "10 years"],
        ["DC Cables",     "4mm UV-resistant solar cable\nMC4 connectors",    "As reqd","10 years"],
        ["AC DB Box",     "IP65 weatherproof + SPD + MCB",                   "1",      "2 years"],
        ["Net Meter",     "Bidirectional DISCOM approved",                    "1",      "Per DISCOM"],
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

    # PAGE 6 — T&C + NEXT STEPS + SIGNATURE
    story.append(sec("Terms, Conditions & Next Steps"))
    story.append(Spacer(1, 0.3*cm))
    tcs = [
        ("Scope",      "Supply, installation, testing and commissioning as per this proposal. Includes civil work for mounting and DC/AC cabling to main board."),
        ("Exclusions", "Net metering application fees, electrical upgrades beyond solar scope not included unless stated."),
        ("Subsidy",    "PM Surya Ghar subsidy subject to government approval. Installer assists with documentation."),
        ("Warranty",   "All equipment as per manufacturer terms. Installation workmanship warranted 1 year from commissioning."),
        ("Validity",   "Proposal valid 30 days from date of issue."),
    ]
    for title, text in tcs:
        story.append(body(f"<b>{title}:</b> {text}"))

    story.append(Spacer(1, 0.4*cm))
    story.append(h2("Next Steps"))
    steps = [
        ["Step", "Action",                             "When"],
        ["1",    "Pay 20% advance to confirm booking", "Today"],
        ["2",    "Site survey and final design",       "Within 3 days"],
        ["3",    "Material delivery",                  "7-10 days"],
        ["4",    "Installation and commissioning",     "1-2 days"],
        ["5",    "Net meter application",              "Post install"],
        ["6",    "Subsidy disbursement",               "30-60 days"],
    ]
    nst = Table(steps, colWidths=[1.5*cm, 11*cm, 4.5*cm])
    nst.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), GREEN),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#EBF5EB"), WHITE]),
        ("FONTSIZE",       (0,0), (-1,-1), 10),
        ("ALIGN",          (0,0), (-1,-1), "CENTER"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCEECC")),
        ("TOPPADDING",     (0,0), (-1,-1), 7),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 7),
    ]))
    story.append(nst)
    story.append(Spacer(1, 0.5*cm))

    sig = [
        ["Customer Signature",  "Installer Representative"],
        ["",                    ""],
        [f"Name: {homeowner}", f"Name: {installer}"],
        ["Date: ___________",  f"Date: {today}"],
    ]
    sigt = Table(sig, colWidths=[8.5*cm, 8.5*cm])
    sigt.setStyle(TableStyle([
        ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,-1), 10),
        ("TEXTCOLOR",     (0,0), (-1,0), DARK_BLUE),
        ("BOX",           (0,0), (0,-1), 0.5, colors.grey),
        ("BOX",           (1,0), (1,-1), 0.5, colors.grey),
        ("TOPPADDING",    (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING",   (0,0), (-1,-1), 8),
        ("ROWHEIGHTS",    {1: 35}),
    ]))
    story.append(sigt)
    story.append(Spacer(1, 0.3*cm))
    story.append(HRFlowable(width="100%", thickness=1, color=DARK_BLUE))
    story.append(Spacer(1, 0.2*cm))
    story.append(small(
        f"{installer}  |  {installer_phone}  |  {installer_email}  |  Powered by SolarQuote"
    ))

    doc.build(story)
    return output_path

# ── MAIN ROUTE ────────────────────────────────────────────────────────────────
@app.route("/api/generate-quote", methods=["POST"])
def generate_quote():
    job_id  = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    try:
        # Parse inputs
        system_kw    = float(request.form.get("system_kw",    5))
        panel_watt   = int(request.form.get("panel_watt",     550))
        panel_count  = int(request.form.get("panel_count",    10))
        roof_type    = request.form.get("roof_type",           "flat_rcc")
        homeowner    = request.form.get("homeowner_name",      "Homeowner")
        monthly_bill = int(request.form.get("monthly_bill",   3000))
        installer    = request.form.get("installer_name",      "Solar Installer")
        iphone       = request.form.get("installer_phone",     "")
        iemail       = request.form.get("installer_email",     "")
        panel_brand  = request.form.get("panel_brand",         "Waaree Solar")
        inv_brand    = request.form.get("inverter_brand",      "Solis")
        leg_heights  = json.loads(request.form.get("leg_heights_ft", "[3]"))

        # Save marked roof photo
        photo      = request.files["photo"]
        photo_path = os.path.join(job_dir, "roof_marked.jpg")
        img        = Image.open(photo.stream).convert("RGB")
        img.thumbnail((1536, 1536), Image.LANCZOS)
        img.save(photo_path, "JPEG", quality=90)

        # Build dynamic prompt
        prompt = build_prompt(
            system_kw, panel_count, panel_watt,
            leg_heights, roof_type
        )

        print(f"\nJob {job_id}")
        print(f"System: {system_kw}kW | Panels: {panel_count} | Legs: {leg_heights}ft")
        print(f"Prompt preview: {prompt[:200]}...")

        # Call OpenAI
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        with open(photo_path, "rb") as img_f:
            response = client.images.edit(
                model  = "gpt-image-1",
                image  = img_f,
                prompt = prompt,
                n      = 1,
                size   = "1024x1024",
            )

        # Save result
        image_bytes = base64.b64decode(response.data[0].b64_json)
        result_path = os.path.join(job_dir, "result.jpg")
        result_img  = Image.open(io.BytesIO(image_bytes))
        result_img.save(result_path, "JPEG", quality=88)

        # Financials
        fin = calculate_financials(panel_count, system_kw, monthly_bill)

        # PDF
        pdf_path = os.path.join(job_dir, "proposal.pdf")
        generate_pdf(
            result_path, fin, installer, homeowner, pdf_path,
            installer_phone=iphone,
            installer_email=iemail,
            panel_brand=panel_brand,
            inverter_brand=inv_brand,
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
    return send_file(os.path.join(UPLOAD_DIR, job_id, filename))

@app.route("/")
def index():
    return app.send_static_file("index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

