export type ApprovalActionLock = {
  isLocked: () => boolean;
  current: () => string | null;
  acquire: (token: string) => boolean;
  release: () => void;
};

export const createApprovalActionLock = (): ApprovalActionLock => {
  let currentToken: string | null = null;

  return {
    isLocked: () => currentToken !== null,
    current: () => currentToken,
    acquire: (token: string) => {
      if (currentToken) {
        return false;
      }
      currentToken = token;
      return true;
    },
    release: () => {
      currentToken = null;
    },
  };
};
