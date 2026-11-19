export interface UpdateEffect {
  readonly textChanged: boolean;
  readonly linksChanged: boolean;
}

export const changeOfUpdate = ({ textChanged, linksChanged }: UpdateEffect) => {
  if (textChanged && linksChanged) {
    return "text_and_links" as const;
  }
  if (textChanged) {
    return "text" as const;
  }
  return linksChanged ? ("links" as const) : undefined;
};
