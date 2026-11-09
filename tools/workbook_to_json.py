"""Convert the Bende results workbook into data/workbook_results.json for the portal's import.

Usage:  python3 tools/workbook_to_json.py path/to/Bende_2023_Election_Results.xlsx
Rules:
  * Only the six typed figures and the Source/notes cell are read. Total, Turnout and Status
    are ignored because the portal recalculates them (some were typed over in the workbook).
  * A row whose six figures are all 0 is imported as BLANK: the sheet was unreadable/missing,
    and zeros would be counted as a confirmed 0-vote result.
  * Free-text notes are mapped onto the portal's fixed sheet-quality list; the original text
    is kept in the notes field.
"""
import json, sys, datetime
import openpyxl

SHEETS = {'presidential': 'Presidential', 'senate': 'Senate', 'reps': 'House of Reps'}
FIELDS = ['pdp', 'apc', 'lp', 'accredited', 'valid', 'rejected']
QUALITY = {
    'Clear': ['clear', 'good', 'g9od', 'fair', 'form is legible'],
    'Clear & stamped': ['clear and stamped', 'clear and staamped'],
    'Stamped': ['stamped'],
    'Not stamped': ['not stamped'],
    'Not clear / blurred': ['not clear', 'unclear', 'form is not clear', 'blurred', 'blur', 'blured and stamped',
                            'blurred and stamped', 'blurred and unstamped', 'stamped; not clear', 'bad'],
    'Illegible': ['illegible', 'inelligible', "blur/can't be read"],
    'Not visible': ['not visible'],
    'No record / not uploaded': ['no record', 'empty', 'not uploaded'],
    'Altered / tampered': ['altered', 'stamped; tampered', 'stamped; very tampered'],
    'Wrong PU / wrong form': ['incorrect pu', 'wrong form uploaded', 'wrong result upload'],
    'Figures incorrect on sheet': ['incorrect figures in sheet', 'computation error'],
}
LOOKUP = {v: k for k, vs in QUALITY.items() for v in vs}

def quality_of(note):
    if note is None: return None
    n = str(note).strip().lower()
    if n.startswith('has the exact details of'): return 'Wrong PU / wrong form'
    return LOOKUP.get(n)

def num(v):
    if v is None or v == '': return None
    if isinstance(v, (int, float)) and float(v).is_integer() and v >= 0: return int(v)
    raise ValueError(f'invalid figure {v!r}')

def main(path):
    wb = openpyxl.load_workbook(path, data_only=False)
    out = {'source': path.split('/')[-1], 'generated': datetime.date.today().isoformat(), 'contests': {}}
    unmapped, blanked = set(), {}
    for key, sheet in SHEETS.items():
        ws, rows, nb = wb[sheet], [], 0
        for r in range(5, ws.max_row + 1):
            code = ws.cell(r, 2).value
            if not code: continue
            vals = {f: num(ws.cell(r, 5 + i).value) for i, f in enumerate(FIELDS)}
            raw = ws.cell(r, 14).value
            raw = str(raw).strip() if raw is not None else ''
            q = quality_of(raw) if raw else None
            if raw and not q: unmapped.add(raw)
            if all(vals[f] == 0 for f in FIELDS):
                vals = {f: None for f in FIELDS}; nb += 1
                raw = (raw + ' ' if raw else '') + '[all figures were 0 on the sheet; imported as blank]'
            if all(v is None for v in vals.values()) and not raw: continue
            rows.append({'code': str(code).strip(), **vals, 'quality': q, 'notes': f'Workbook: {raw}' if raw else ''})
        out['contests'][key] = rows
        blanked[key] = nb
    json.dump(out, open('data/workbook_results.json', 'w'), indent=1)
    print({k: len(v) for k, v in out['contests'].items()}, 'all-zero rows blanked:', blanked)
    if unmapped: print('UNMAPPED notes (kept as text, no quality):', sorted(unmapped))

if __name__ == '__main__':
    main(sys.argv[1])
