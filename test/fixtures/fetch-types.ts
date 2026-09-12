async function checkFetchTypes(url: string): Promise<number> {
  const request = new Request(url, { headers: { Accept: 'application/json' } });
  const response = await fetch(request);
  const contentType: string | null = response.headers.get('content-type');
  const body: string = await response.text();
  return response.ok && contentType !== null && body.length > 0 ? response.status : 0;
}

void checkFetchTypes;
export {};
