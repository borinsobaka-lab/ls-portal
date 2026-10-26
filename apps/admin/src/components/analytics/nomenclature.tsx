import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/skeletons";
import { EmptyBlock } from "@/components/analytics/parts";
import { formatRub, nomenclature, type NomenclatureFilter } from "@/lib/analytics/logic";
import type { SalesData } from "@/lib/analytics/types";
import { formatNumber } from "@/lib/format";

/**
 * «Что покупают»: номенклатуры абонементов за период — все, только новые
 * или повторные (продления и возвращённые), как в «Моём городе» Lady Stretch.
 */
export function NomenclatureTable({
  data,
  ids,
  filter,
  limit,
}: {
  /** undefined — ещё грузится: болванки строк под настоящей шапкой. */
  data: SalesData | undefined;
  ids: Set<string>;
  filter: NomenclatureFilter;
  limit?: number;
}) {
  const lines = data ? nomenclature(data, ids, filter).slice(0, limit) : [];
  if (data && lines.length === 0) return <EmptyBlock />;
  const total = lines.reduce((s, l) => s + l.count, 0);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Номенклатура</TableHead>
          <TableHead className="text-right [&>span]:justify-end">Продано</TableHead>
          <TableHead className="text-right [&>span]:justify-end">Доля</TableHead>
          <TableHead className="text-right [&>span]:justify-end">Оплаты</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!data && <TableSkeletonRows columns={4} rows={5} />}
        {lines.map((l) => (
          <TableRow key={l.key}>
            <TableCell className="font-medium">{l.name}</TableCell>
            <TableCell className="text-right">{formatNumber(l.count)}</TableCell>
            <TableCell className="text-right">{Math.round((l.count / total) * 100)}%</TableCell>
            <TableCell className="text-right">{formatRub(l.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
