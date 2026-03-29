export const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const is = {
  number: (str: any): boolean => {
    return typeof str === 'number';
  },
  array: (array: any): boolean => {
    return typeof array === 'object' && array != null && array.length > 0;
  },
  undefined: (elem: any): boolean => {
    return typeof elem === 'undefined';
  },
  file: (file: any): boolean => {
    return file instanceof File;
  },
  object: (object: any): boolean => {
    return typeof object === 'object' && object !== null && Object.keys(object).length > 0;
  },
  string: (str: any): boolean => {
    return typeof str === 'string';
  },
};

export const to = {
  string: (str: any): string => {
    if (typeof str === 'string') return str;
    if (typeof str === 'number') return `${str} `.trim();
    return '';
  },
  undefined: (str: any, defaultValue = undefined): string | number | undefined => {
    if ((typeof str === 'string' || typeof str === 'number') && str !== '') return str;
    return defaultValue;
  },
  number: (num: any, defaultNumber = 0) => {
    num = to.string(num).replace(/[^\d.-]/g, '');
    if (is.undefined(num) || num === null || Number.isNaN(num)) return defaultNumber;
    return Number(num);
  },
  boolean: (value: any): boolean => {
    if (typeof value === 'undefined') return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      value = value.toLowerCase().trim();
      return value === 'true' || value === '1';
    }
    return false;
  },
};
