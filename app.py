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

def generate_pdf(image_path, fin, installer, homeowner, output_path):
    doc    = SimpleDocTemplate(output_path, pagesize=A4,
                rightMargin=1.5*cm, leftMargin=1.5*cm,
                topMargin=1.5*cm,   bottomMargin=1.5*cm)
    styles = getSampleStyleSheet()
    story  = []
    story.append(Paragraph(
        "<b>Solar Installation Proposal</b>",
        ParagraphStyle("H", parent=styles["Title"], fontSize=22,
            textColor=colors.HexColor("#1a3a5c"),
            alignment=TA_CENTER, spaceAfter=4)
    ))
    story.append(Paragraph(
        f"{installer}  |  Prepared for: {homeowner}  |  {datetime.today().strftime('%d %b %Y')}",
        ParagraphStyle("S", parent=styles["Normal"], fontSize=10,
            textColor=colors.grey, alignment=TA_CENTER, spaceAfter=8)
    ))
    story.append(HRFlowable(width="100%", thickness=2,
        color=colors.HexColor("#1a3a5c")))
    story.append(Spacer(1, 0.3*cm))
    story.append(RLImage(image_path, width=17*cm, height=10*cm))
    story.append(Spacer(1, 0.4*cm))
    story.append(Paragraph(
        f"<b>Proposed: {fin['system_kw']} kW  |  {fin['panel_count']} Panels  |  {fin['yearly_kwh']:,} kWh/year</b>",
        ParagraphStyle("SL", parent=styles["Normal"], fontSize=12,
            textColor=colors.HexColor("#1a3a5c"),
            alignment=TA_CENTER, spaceAfter=10)
    ))
    data = [
        ["Financial Summary",          ""],
        ["Total System Cost",          f"Rs {fin['total_cost']:,}"],
        ["PM Surya Ghar Subsidy",      f"- Rs {fin['subsidy']:,}"],
        ["Your Net Investment",        f"Rs {fin['net_cost']:,}"],
        ["Annual Electricity Savings", f"Rs {fin['annual_savings']:,}"],
        ["Payback Period",             f"{fin['payback_years']} years"],
        ["25-Year Net Savings",        f"Rs {fin['savings_25yr']:,}"],
    ]
    t = Table(data, colWidths=[10*cm, 7*cm])
    t.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), colors.HexColor("#1a3a5c")),
        ("TEXTCOLOR",      (0,0), (-1,0), colors.white),
        ("SPAN",           (0,0), (-1,0)),
        ("ALIGN",          (0,0), (-1,0), "CENTER"),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 11),
        ("ROWBACKGROUNDS", (0,1), (-1,-1),
            [colors.HexColor("#EBF3FB"), colors.white]),
        ("FONTSIZE",       (0,1), (-1,-1), 10),
        ("ALIGN",          (1,1), (1,-1), "RIGHT"),
        ("GRID",           (0,0), (-1,-1), 0.3, colors.HexColor("#CCDDEE")),
        ("TOPPADDING",     (0,0), (-1,-1), 6),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 6),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        "Proposal based on site photos and AI-assisted design. "
        "Final specifications confirmed at engineering survey. "
        "Subsidy subject to PM Surya Ghar eligibility and DISCOM approval.",
        ParagraphStyle("D", parent=styles["Normal"],
            fontSize=7, textColor=colors.grey, alignment=TA_CENTER)
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
        generate_pdf(result_path, fin, installer, homeowner, pdf_path)

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
