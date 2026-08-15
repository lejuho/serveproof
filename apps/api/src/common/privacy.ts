export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export function maskWallet(address: string | null | undefined): string | null {
  if (!address) return null;
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
