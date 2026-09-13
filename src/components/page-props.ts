export type Query = Record<string, string | string[] | undefined>;
export type PageProps<Params = Record<string, never>> = {
  params: Promise<Params>;
  searchParams: Promise<Query>;
};
