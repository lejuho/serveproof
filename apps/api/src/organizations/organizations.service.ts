import { Injectable, NotFoundException } from "@nestjs/common";
import type { OrgRole } from "@serveproof/db";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Spec §22 — POST /organizations. Creator becomes OWNER. */
  createOrganization(
    creatorUserId: string,
    input: { legalName: string; displayName: string; country: string; timezone: string },
  ) {
    return this.prisma.organization.create({
      data: {
        ...input,
        members: { create: { userId: creatorUserId, role: "OWNER" } },
      },
      include: { members: true },
    });
  }

  /** Spec §22 — POST /organizations/:id/members. Invite by email (user must exist). */
  async addMember(organizationId: string, input: { email: string; role: OrgRole }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user) {
      throw new NotFoundException(`No user with email ${input.email}; they must log in once first`);
    }
    // OTP signup defaults GlobalRole to WORKER, which routes the web login to
    // /me. Staff membership implies the manager surface, so upgrade (never
    // downgrade) the global role; takes effect on their next login.
    if (user.role === "WORKER" && input.role !== "VIEWER") {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { role: "VENUE_MANAGER" },
      });
    }
    return this.prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      update: { role: input.role },
      create: { organizationId, userId: user.id, role: input.role },
    });
  }

  listMine(userId: string) {
    return this.prisma.organization.findMany({
      where: { members: { some: { userId } } },
      include: { venues: true, members: { include: { user: { select: { email: true } } } } },
    });
  }

  /** Spec §22 — POST /venues */
  createVenue(input: {
    organizationId: string;
    name: string;
    timezone: string;
    externalIds?: Record<string, string>;
  }) {
    return this.prisma.venue.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        timezone: input.timezone,
        externalIds: input.externalIds ?? {},
      },
    });
  }

  async getVenue(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { allocationPolicies: { orderBy: { version: "desc" } } },
    });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);
    return venue;
  }

  /** Spec §22 — POST /venues/:id/wallet (payout signer wallet, §9.3) */
  setVenueWallet(venueId: string, payoutSignerWallet: string) {
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { payoutSignerWallet },
    });
  }
}
