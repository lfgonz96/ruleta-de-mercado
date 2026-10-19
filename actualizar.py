"""
Regenera index.html con listas frescas.

Qué hace:
  1. Baja los constituyentes del S&P 500 (datasets/s-and-p-500-companies, en GitHub).
  2. Baja el top 50 por market cap de CoinGecko.
  3. Marca como "stablecoin o activo tokenizado" a los tokens que no sirven para investigar.
  4. Inserta todo en plantilla.html y escribe index.html.

Uso:  python actualizar.py
Solo usa la librería estándar de Python (no hay que instalar nada).
"""
import csv
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

AQUI = Path(__file__).resolve().parent
URL_SP500 = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
URL_COINGECKO = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd&order=market_cap_desc&per_page=60&page=1"
)

SECTORES_ES = {
    "Information Technology": ("Tecnología", "Tecnología"),
    "Financials": ("Finanzas", "Finanzas"),
    "Health Care": ("Salud", "Salud"),
    "Consumer Discretionary": ("Consumo discrecional", "Consumo discr."),
    "Industrials": ("Industriales", "Industriales"),
    "Communication Services": ("Comunicación", "Comunicación"),
    "Consumer Staples": ("Consumo básico", "Consumo básico"),
    "Energy": ("Energía", "Energía"),
    "Utilities": ("Servicios públicos", "Serv. públicos"),
    "Real Estate": ("Inmobiliario", "Inmobiliario"),
    "Materials": ("Materiales", "Materiales"),
}

# Stablecoins y activos tokenizados conocidos (ids de CoinGecko).
STABLES_CONOCIDOS = {
    "tether", "usd-coin", "figure-heloc", "usds", "ethena-usde", "dai",
    "usd1-wlfi", "global-dollar", "tether-gold", "paypal-usd", "ripple-usd",
    "hashnote-usyc", "ondo-us-dollar-yield", "pax-gold",
    "blackrock-usd-institutional-digital-liquidity-fund",
}
# Para detectar los nuevos que aparezcan en el top 50.
PATRON_STABLE = re.compile(r"usd|dollar|\bdai\b|gold|treasury|liquidity fund|heloc|\beur", re.I)


def bajar(url, intentos=4, espera=30):
    """Descarga una URL. Si CoinGecko responde 429 (demasiados pedidos), espera y reintenta."""
    pedido = urllib.request.Request(url, headers={"User-Agent": "ruleta-de-mercado/1.0"})
    for n in range(1, intentos + 1):
        try:
            with urllib.request.urlopen(pedido, timeout=60) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code != 429 or n == intentos:
                raise
            print(f"Límite de pedidos (429). Reintento {n}/{intentos - 1} en {espera} s...")
            time.sleep(espera)


def armar_acciones():
    filas = list(csv.DictReader(io.StringIO(bajar(URL_SP500))))
    cuenta = {}
    for f in filas:
        cuenta[f["GICS Sector"]] = cuenta.get(f["GICS Sector"], 0) + 1
    orden = sorted(cuenta, key=lambda s: (-cuenta[s], s))
    faltan = [s for s in orden if s not in SECTORES_ES]
    if faltan:
        sys.exit(f"Hay sectores sin traducción en SECTORES_ES: {faltan}")
    indice = {s: i for i, s in enumerate(orden)}
    sectores = [{"name": SECTORES_ES[s][0], "short": SECTORES_ES[s][1]} for s in orden]
    filas.sort(key=lambda f: (indice[f["GICS Sector"]], f["Symbol"]))
    acciones = [[f["Symbol"], f["Security"], indice[f["GICS Sector"]], int(f["CIK"])] for f in filas]
    return sectores, acciones


def armar_tokens():
    datos = json.loads(bajar(URL_COINGECKO))
    tokens = []
    for c in datos:
        rank = c.get("market_cap_rank")
        if not rank or rank > 50:
            continue
        nombre = c["name"].replace("(prev. Toncoin)", "(ex Toncoin)")
        es_stable = c["id"] in STABLES_CONOCIDOS or bool(PATRON_STABLE.search(f'{c["name"]} {c["symbol"]}'))
        tokens.append([rank, c["id"], c["symbol"].upper(), nombre, 1 if es_stable else 0])
    tokens.sort(key=lambda t: t[0])
    return tokens


def main():
    sectores, acciones = armar_acciones()
    tokens = armar_tokens()
    if len(acciones) < 400 or len(tokens) < 40:
        sys.exit(f"Datos incompletos (acciones={len(acciones)}, tokens={len(tokens)}). No escribo nada.")

    datos = {"sectors": sectores, "stocks": acciones, "coins": tokens}
    plantilla = (AQUI / "plantilla.html").read_text(encoding="utf-8")
    fecha = date.today().strftime("%d/%m/%Y")
    html = plantilla.replace("/*DATA*/null", json.dumps(datos, ensure_ascii=False, separators=(",", ":")))
    html = html.replace("{{FECHA}}", fecha)
    (AQUI / "index.html").write_text(html, encoding="utf-8")

    excluidos = [f"{t[2]} ({t[3]})" for t in tokens if t[4]]
    print(f"Acciones: {len(acciones)} en {len(sectores)} sectores")
    print(f"Tokens: {len(tokens)} en el top 50, {len(excluidos)} marcados como stablecoin/tokenizado:")
    for e in excluidos:
        print("  -", e)
    print("Revisá esa lista: si falta o sobra alguno, ajustá STABLES_CONOCIDOS.")
    print(f"index.html escrito ({fecha}).")


if __name__ == "__main__":
    main()
