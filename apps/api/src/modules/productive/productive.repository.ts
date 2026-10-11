import { Injectable } from "@nestjs/common";
import { type Executor, productiveConnection } from "@yugotool/db";
import { eq } from "drizzle-orm";

const ROW_ID = "default";

export type ProductiveConnectionRow = typeof productiveConnection.$inferSelect;
export type ProductiveConnectionValues = Omit<ProductiveConnectionRow, "id" | "connectedAt">;

@Injectable()
export class ProductiveRepository {
  async find(db: Executor): Promise<ProductiveConnectionRow | null> {
    const [row] = await db
      .select()
      .from(productiveConnection)
      .where(eq(productiveConnection.id, ROW_ID));
    return row ?? null;
  }

  /** One connection per install: a new connect replaces the old one. */
  async save(db: Executor, values: ProductiveConnectionValues): Promise<ProductiveConnectionRow> {
    const [row] = await db
      .insert(productiveConnection)
      .values({ id: ROW_ID, ...values })
      .onConflictDoUpdate({
        target: productiveConnection.id,
        set: { ...values, connectedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error("productive connection upsert returned nothing");
    return row;
  }

  async remove(db: Executor): Promise<void> {
    await db.delete(productiveConnection).where(eq(productiveConnection.id, ROW_ID));
  }
}
