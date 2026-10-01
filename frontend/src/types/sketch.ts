/** 岩性素描结构面线段（按掌子面稳定编号跨设备合并） */
export interface SketchSegment {
  id: string;
  /** 线中点 x（视图坐标） */
  x: number;
  /** 线中点 y（视图坐标） */
  y: number;
  /** 结构面倾角 ° */
  dipAngle: number;
  /** 结构面倾向 ° */
  dipDirection: number;
  /** 线长（视图坐标） */
  length: number;
  label: string;
  /** 来源设备（合并时保留） */
  source?: string;
  /** 来源设备内录入顺序 */
  seq?: number;
}
