import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { stampProvenance, touchProvenance } from '../utils/device';
import type { RockMassGrade, RockMassGradeDraft } from '../types/grade';
import type { WaterInflow, WaterInflowDraft } from '../types/water';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
    watersByFace: (state) => (faceId: string) =>
      state.waters
        .filter((it) => it.faceId === faceId)
        .sort((a, b) => a.chainage - b.chainage || (a.provenance?.seq ?? 0) - (b.provenance?.seq ?? 0)),
  },
  actions: {
    async load() {
      const grades = await db.grades.toArray();
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt);
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage);
      this.loaded = true;
    },
    async addGrade(draft: RockMassGradeDraft) {
      const record: RockMassGrade = {
        ...toPlain(draft),
        id: newId('grade'),
        judgedAt: Date.now(),
        provenance: stampProvenance(),
      };
      await db.grades.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    async addWater(draft: WaterInflowDraft) {
      const record: WaterInflow = {
        ...toPlain(draft),
        id: newId('water'),
        measuredAt: Date.now(),
        provenance: stampProvenance(),
      };
      await db.waters.put(toPlain(record));
      this.waters = [...this.waters, record].sort((a, b) => a.chainage - b.chainage);
      return record;
    },
    async updateWater(id: string, patch: Partial<WaterInflow>) {
      const current = this.waters.find((it) => it.id === id);
      const plain = toPlain({ ...patch, provenance: touchProvenance(current?.provenance) });
      await db.waters.update(id, plain);
      this.waters = this.waters.map((it) => (it.id === id ? { ...it, ...plain } : it)).sort((a, b) => a.chainage - b.chainage);
    },
    async removeWater(id: string) {
      await db.waters.delete(id);
      this.waters = this.waters.filter((it) => it.id !== id);
    },
  },
});
