import type { MdTableData, TemplateRenderer } from './types.ts';

export const mdTableTemplate: TemplateRenderer<MdTableData> = {
  render(_data: MdTableData): string {
    throw new Error('md-table template not yet implemented');
  },
};
