import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MappingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Spec §22 — GET /venues/:venueId/unmapped-workers
   * External worker ids seen in shift evidence that have no CONFIRMED mapping,
   * plus PENDING mapping candidates.
   */
  async listUnmapped(venueId: string) {
    const shifts = await this.prisma.shiftEvidence.findMany({
      where: { venueId, mappedWorkerId: null },
      select: { provider: true, externalWorkerId: true },
      distinct: ["provider", "externalWorkerId"],
    });
    const pending = await this.prisma.externalWorkerAccount.findMany({
      where: { venueId, mappingStatus: "PENDING" },
      include: { worker: { include: { user: { select: { displayName: true, email: true } } } } },
    });
    return { unmappedShiftWorkers: shifts, pendingMappings: pending };
  }

  /**
   * Spec §22 — POST /worker-mappings. The worker can be referenced by id or,
   * like org member invites, by account email (they must have logged in once).
   */
  async createMapping(input: {
    workerId?: string;
    workerEmail?: string;
    venueId: string;
    provider: string;
    externalWorkerId: string;
  }) {
    let workerId = input.workerId;
    if (!workerId) {
      const user = await this.prisma.user.findUnique({
        where: { email: (input.workerEmail ?? "").toLowerCase() },
        include: { worker: true },
      });
      if (!user?.worker) {
        throw new NotFoundException(
          `No worker account for ${input.workerEmail}; they must log in once first`,
        );
      }
      workerId = user.worker.id;
    }
    const worker = await this.prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    return this.prisma.externalWorkerAccount.upsert({
      where: {
        venueId_provider_externalWorkerId: {
          venueId: input.venueId,
          provider: input.provider,
          externalWorkerId: input.externalWorkerId,
        },
      },
      update: { workerId, mappingStatus: "PENDING" },
      create: {
        workerId,
        venueId: input.venueId,
        provider: input.provider,
        externalWorkerId: input.externalWorkerId,
        mappingStatus: "PENDING",
      },
    });
  }

  async getMappingVenueId(id: string): Promise<string> {
    const mapping = await this.prisma.externalWorkerAccount.findUnique({
      where: { id },
      select: { venueId: true },
    });
    if (!mapping) throw new NotFoundException(`Mapping ${id} not found`);
    return mapping.venueId;
  }

  /**
   * Spec §22 — PATCH /worker-mappings/:id/verify
   * Confirms the mapping and backfills mappedWorkerId on existing shift evidence.
   */
  async verifyMapping(id: string, verifiedBy: string) {
    const mapping = await this.prisma.externalWorkerAccount.findUnique({ where: { id } });
    if (!mapping) throw new NotFoundException(`Mapping ${id} not found`);
    if (mapping.mappingStatus === "REJECTED") {
      throw new BadRequestException("Rejected mapping cannot be verified");
    }

    const [updated, backfill] = await this.prisma.$transaction([
      this.prisma.externalWorkerAccount.update({
        where: { id },
        data: { mappingStatus: "CONFIRMED", verifiedBy, verifiedAt: new Date() },
      }),
      this.prisma.shiftEvidence.updateMany({
        where: {
          venueId: mapping.venueId,
          provider: mapping.provider,
          externalWorkerId: mapping.externalWorkerId,
          mappedWorkerId: null,
        },
        data: { mappedWorkerId: mapping.workerId },
      }),
    ]);

    return { mapping: updated, backfilledShifts: backfill.count };
  }
}
