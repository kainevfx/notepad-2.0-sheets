// CSV / TSV in the sheet editor's grid: edit, sort, filter, freeze, resize and move rows and
// columns (the Source view edits the same text; formatting is off because CSV can't store it).
import type { ViewerProps } from '../ViewerPane';
import { SheetEditor } from '../sheet/SheetEditor';

export function TableViewer({ doc, text }: ViewerProps) {
  return <SheetEditor doc={doc} text={text} mode="csv" />;
}
