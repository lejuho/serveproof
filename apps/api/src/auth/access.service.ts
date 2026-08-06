import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { OrgRole } from "@serveproof/db";
import { PrismaService } from "../prisma/prisma.service";

export const VENUE_MANAGE_ROLES: OrgRole[] = ["OWNER", "MANAGER"];
export const VENUE_READ_ROLES: OrgRole[] = ["OWNER", "MANAGER", "PAYROLL_ADMIN", "VIEWER"];

/**
 * Organization-scoped RBAC (spec §4.3, §11.3) with tenant isolation (§24):
 * every venue-scoped operation asserts the acting user's membership in the
 * venue's organization before touching data.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertOrgRole(userId: string, organizationId: string, allowed: OrgRole[]): Promise<void> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!membership || !allowed.includes(membership.role)) {
      throw new ForbiddenException("Insufficient organization role");
    }
  }

  async assertVenueRole(userId: string, venueId: string, allowed: OrgRole[]): Promise<void> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    });
    if (!venue) throw new NotFoundException(`Venue ${venueId} not found`);

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: venue.organizationId, userId },
      },
    });
    if (!membership || !allowed.includes(membership.role)) {
      throw new ForbiddenException("Insufficient organization role for this venue");
    }
  }
}
