import { useState, useEffect, useCallback } from 'react';

export type WxtStorageItem<T> = {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
  watch(cb: (newValue: T, oldValue: T) => void): () => void;
};

export function useStorageItem<T>(item: WxtStorageItem<T>, fallback: T): [T, (value: T) => Promise<void>] {
  const [value, setValueState] = useState<T>(fallback);

  useEffect(() => {
    let mounted = true;
    item.getValue().then((val) => {
      if (mounted) setValueState(val);
    });
    const unwatch = item.watch((newVal) => {
      if (mounted) setValueState(newVal);
    });
    return () => {
      mounted = false;
      unwatch();
    };
  }, [item]);

  const setValue = useCallback(
    async (newValue: T) => {
      setValueState(newValue);
      await item.setValue(newValue);
    },
    [item],
  );

  return [value, setValue];
}
