"""
Regenera index.html con listas frescas.

Qué hace:
  1. Baja los constituyentes del S&P 500 (datasets/s-and-p-500-companies, en GitHub).
  2. Averigua en qué bolsa cotiza cada acción (listados oficiales de Nasdaq Trader).
  3. Baja el top 50 por market cap de CoinGecko (con suministro circulante y máximo).
  4. Marca como "stablecoin o activo tokenizado" a los tokens que no sirven para investigar.
  5. Busca para cada token un símbolo de TradingView que exista (para los widgets).
  6. Inserta todo en plantilla.html y escribe index.html.

Uso:  python actualizar.py
Solo usa la librería estándar de Python (no hay que instalar nada).

Nota: el paso 5 y la validación de acciones usan el "scanner" público de TradingView, que no es
una API oficial. Si falla, el script sigue: las acciones usan la bolsa de Nasdaq Trader sin validar
y los tokens quedan sin widgets de TradingView (el gráfico de CoinGecko sigue funcionando).
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
URL_NASDAQ = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
URL_OTRAS = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
URL_TV_ACCIONES = "https://scanner.tradingview.com/america/scan"
URL_TV_CRIPTO = "https://scanner.tradingview.com/crypto/scan"

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

# Códigos de bolsa de Nasdaq Trader -> prefijo de TradingView.
BOLSAS_TV = {"A": "AMEX", "N": "NYSE", "P": "NYSE", "Z": "CBOE", "V": "IEX"}

# Tokens cuyo ticker en las bolsas difiere del de CoinGecko.
ALIAS_TV = {"GRAM": ["TON"]}
# Mercados donde buscar cada token, en orden de preferencia: (bolsa, moneda cotizada).
MERCADOS_TV = [
    ("BINANCE", "USDT"), ("COINBASE", "USD"), ("BYBIT", "USDT"), ("OKX", "USDT"),
    ("KUCOIN", "USDT"), ("GATEIO", "USDT"), ("MEXC", "USDT"), ("BITGET", "USDT"),
    ("BITSTAMP", "USD"), ("KRAKEN", "USD"),
]


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


def existentes_en_tradingview(url, simbolos):
    """Devuelve el conjunto de símbolos 'BOLSA:TICKER' que TradingView reconoce, o None si falla."""
    hallados = set()
    try:
        for i in range(0, len(simbolos), 150):
            cuerpo = json.dumps({"symbols": {"tickers": simbolos[i:i + 150]}, "columns": ["name"]}).encode()
            pedido = urllib.request.Request(
                url, data=cuerpo, headers={"Content-Type": "application/json", "User-Agent": "ruleta-de-mercado/1.0"}
            )
            with urllib.request.urlopen(pedido, timeout=60) as r:
                for d in json.load(r)["data"]:
                    hallados.add(d["s"])
        return hallados
    except Exception as e:  # el scanner no es oficial: si falla, seguimos sin validar
        print(f"Aviso: no pude consultar el scanner de TradingView ({e}).")
        return None


def bolsas_de_acciones():
    """Mapa ticker -> prefijo de bolsa de TradingView, con los listados de Nasdaq Trader."""
    mapa = {}
    try:
        for linea in bajar(URL_NASDAQ).splitlines()[1:]:
            p = linea.split("|")
            if len(p) > 3 and not linea.startswith("File Creation"):
                mapa[p[0]] = "NASDAQ"
        for linea in bajar(URL_OTRAS).splitlines()[1:]:
            p = linea.split("|")
            if len(p) > 3 and not linea.startswith("File Creation"):
                bolsa = BOLSAS_TV.get(p[2], p[2])
                mapa[p[0]] = bolsa
                mapa[p[3]] = bolsa
    except Exception as e:
        print(f"Aviso: no pude bajar los listados de Nasdaq Trader ({e}). Las acciones irán sin bolsa.")
    return mapa


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

    bolsas = bolsas_de_acciones()

    def simbolo_tv(t):
        b = bolsas.get(t) or bolsas.get(t.replace(".", "")) or bolsas.get(t.replace(".", "-"))
        return f"{b}:{t}" if b else t

    tv = [simbolo_tv(f["Symbol"]) for f in filas]
    validos = existentes_en_tradingview(URL_TV_ACCIONES, [s for s in tv if ":" in s])
    if validos is not None:
        malos = [s for s in tv if ":" in s and s not in validos]
        if malos:
            print(f"Aviso: {len(malos)} acciones sin símbolo válido en TradingView, uso solo el ticker: {malos[:10]}")
        tv = [s if (":" not in s or s in validos) else s.split(":", 1)[1] for s in tv]

    acciones = []
    for f, s in zip(filas, tv):
        agregada = (f.get("Date added") or "")[:4]
        acciones.append([
            f["Symbol"], f["Security"], indice[f["GICS Sector"]], int(f["CIK"]), s,
            f.get("GICS Sub-Industry", ""), f.get("Headquarters Location", ""),
            f.get("Founded", ""), int(agregada) if agregada.isdigit() else "",
        ])
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
        tokens.append([
            rank, c["id"], c["symbol"].upper(), nombre, 1 if es_stable else 0, "",
            c.get("circulating_supply"), c.get("max_supply"),
        ])
    tokens.sort(key=lambda t: t[0])

    candidatos = {}
    for t in tokens:
        bases = ALIAS_TV.get(t[2], [t[2]])
        candidatos[t[2]] = [f"{b}:{base}{q}" for base in bases for b, q in MERCADOS_TV]
    todos = sorted({s for lista in candidatos.values() for s in lista})
    validos = existentes_en_tradingview(URL_TV_CRIPTO, todos)
    if validos is not None:
        for t in tokens:
            t[5] = next((s for s in candidatos[t[2]] if s in validos), "")
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
    sin_tv = [t[2] for t in tokens if not t[5]]
    print(f"Acciones: {len(acciones)} en {len(sectores)} sectores")
    print(f"Tokens: {len(tokens)} en el top 50, {len(excluidos)} marcados como stablecoin/tokenizado:")
    for e in excluidos:
        print("  -", e)
    print("Revisá esa lista: si falta o sobra alguno, ajustá STABLES_CONOCIDOS.")
    if sin_tv:
        print(f"Tokens sin símbolo de TradingView (solo tendrán el gráfico de CoinGecko): {', '.join(sin_tv)}")
    print(f"index.html escrito ({fecha}).")


if __name__ == "__main__":
    main()
