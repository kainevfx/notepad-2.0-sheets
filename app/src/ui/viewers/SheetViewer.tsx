// Spreadsheets (.xlsx, .xls, .ods): each sheet as a grid, sheet tabs along the bottom.
// Read in Rust (calamine); values shown as Excel displays them, formulas as their results.
import { useEffect, useState } from 'preact/hooks';
import type { ViewerProps } from '../ViewerPane';
import type { Workbook } from '../../platform/types';
import { platform } from '../../platform';
import { sheetExport } from '../../state/app';
import { Grid } from './Grid';
import { Notice } from './Notice';
import { SheetEditor } from '../sheet/SheetEditor';

/** The sheet each open workbook was showing, so switching tabs keeps it. */
const activeSheet = new Map<string, number>();

/** .xlsx opens in the sheet editor; .xls and .ods stay read-only (shown from calamine). */
export function SheetViewer(props: ViewerProps) {
  if (props.doc.path && /\.xlsx$/i.test(props.doc.path)) return <SheetEditor doc={props.doc} text="" mode="xlsx" fallback={<ReadOnlySheet {...props} />} />;
  return <ReadOnlySheet {...props} />;
}

function ReadOnlySheet({ doc }: ViewerProps) {
  const [wb, setWb] = useState<Workbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(() => activeSheet.get(doc.id) ?? 0);

  useEffect(() => {
    if (!doc.path) return;
    let live = true;
    setError(null);
    platform
      .readSheet(doc.path)
      .then((w) => live && setWb(w))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [doc.path, doc.rev]);

  const sheet = wb?.sheets[Math.min(idx, (wb?.sheets.length ?? 1) - 1)];
  useEffect(() => {
    sheetExport.current = sheet ? () => ({ name: sheet.name, rows: sheet.rows, truncated: sheet.truncated }) : null;
    return () => {
      sheetExport.current = null;
    };
  }, [sheet]);

  if (error) return <Notice text="Couldn't read this workbook." detail={error} path={doc.path} />;
  if (!wb) return <div class="viewer-loading">Reading workbook…</div>;
  if (!wb.sheets.length || !sheet) return <Notice text="This workbook has no sheets." path={doc.path} />;

  const pick = (i: number) => {
    activeSheet.set(doc.id, i);
    setIdx(i);
  };
  return (
    <>
      {sheet.rows.length ? <Grid rows={sheet.rows} truncated={sheet.truncated} /> : <div class="grid-empty">This sheet is empty.</div>}
      <div class="sheet-tabs" role="tablist">
        {wb.sheets.map((s, i) => (
          <button key={s.name} role="tab" aria-selected={s === sheet} class={`sheet-tab${s === sheet ? ' on' : ''}`} onClick={() => pick(i)}>
            {s.name}
          </button>
        ))}
      </div>
    </>
  );
}
