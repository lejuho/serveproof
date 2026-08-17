import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { rebuildVenueIncome } from "@serveproof/db";
import { MailService } from "../auth/mail.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MappingsService {
  private readonly logger = new Logger(MappingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

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
    const pendingKeys = new Set(pending.map((item) => `${item.provider}:${item.externalWorkerId}`));
    return {
      unmappedShiftWorkers: shifts.filter(
        (item) => !pendingKeys.has(`${item.provider}:${item.externalWorkerId}`),
      ),
      pendingMappings: pending,
    };
  }

  /**
   * Spec §22 — POST /worker-mappings. The worker can be referenced by id or,
   * like org member invites, by account email. An email without an account is
   * onboarded on the spot: since first OTP login doubles as signup, we
   * pre-create the user in the same shape so the invite email's login link
   * lands the worker in this account with the request already waiting.
   */
  async createMapping(input: {
    workerId?: string;
    workerEmail?: string;
    venueId: string;
    provider: string;
    externalWorkerId: string;
  }) {
    let workerId = input.workerId;
    let accountCreated = false;
    if (!workerId) {
      const email = (input.workerEmail ?? "").toLowerCase();
      let user = await this.prisma.user.findUnique({
        where: { email },
        include: { worker: true },
      });
      if (!user) {
        user = await this.prisma.user.create({
          data: {
            authUserId: `otp:${email}`,
            email,
            displayName: email.split("@")[0] ?? email,
            role: "WORKER",
            worker: { create: {} },
          },
          include: { worker: true },
        });
        accountCreated = true;
      }
      const worker =
        user.worker ??
        (await this.prisma.worker.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id },
        }));
      workerId = worker.id;
    }
    const worker = await this.prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const mapping = await this.prisma.externalWorkerAccount.upsert({
      where: {
        venueId_provider_externalWorkerId: {
          venueId: input.venueId,
          provider: input.provider,
          externalWorkerId: input.externalWorkerId,
        },
      },
      update: {
        workerId,
        mappingStatus: "PENDING",
        verifiedBy: null,
        verifiedAt: null,
      },
      create: {
        workerId,
        venueId: input.venueId,
        provider: input.provider,
        externalWorkerId: input.externalWorkerId,
        mappingStatus: "PENDING",
      },
    });

    // 이미 정산되어 연결만 기다리는 몫 — 초대 수락의 가장 강한 유인
    const heldAggregate = await this.prisma.workerAllocation.aggregate({
      _sum: { netAllocatedUsdCents: true },
      where: {
        workerId: null,
        provider: input.provider,
        externalWorkerId: input.externalWorkerId,
        batch: { venueId: input.venueId },
      },
    });
    const heldUsdCents = heldAggregate._sum.netAllocatedUsdCents ?? 0;
    const heldUsd = `$${(heldUsdCents / 100).toFixed(2)}`;

    let invitationEmailSent = false;
    if (input.workerEmail && this.mail.enabled) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: input.venueId },
        select: { name: true },
      });
      try {
        const origin = (process.env.WEB_ORIGIN ?? "https://serveproof-web.vercel.app").replace(
          /\/$/,
          "",
        );
        await this.mail.send(
          input.workerEmail,
          `[ServeProof] ${venue?.name ?? "A venue"} sent an account connection request`,
          [
            `${venue?.name ?? "사업장"}에서 ${input.provider} 직원 ID ${input.externalWorkerId}를 이 ServeProof 계정에 연결해 달라고 요청했습니다.`,
            ...(heldUsdCents > 0
              ? [`이미 정산된 팁 ${heldUsd}가 계정 연결을 기다리고 있습니다. 수락하면 지급 가능 상태가 됩니다.`]
              : []),
            ...(accountCreated
              ? [
                  "아직 ServeProof를 써본 적이 없어도 괜찮습니다. 아래 링크에서 이 이메일 주소로 로그인(인증 코드 입력)하면 계정이 바로 준비되고, 연결 요청을 확인할 수 있습니다.",
                ]
              : []),
            "본인의 근무 계정이 맞는 경우 ServeProof의 근무 탭에서 수락해 주세요.",
            "본인이 아니라면 거절하세요. 수락 전에는 근무·소득 기록이 계정에 연결되지 않습니다.",
            "",
            `${venue?.name ?? "A venue"} asked to connect ${input.provider} worker ID ${input.externalWorkerId} to this ServeProof account.`,
            ...(heldUsdCents > 0
              ? [`${heldUsd} in settled tips is already waiting for this connection — accepting makes it payable.`]
              : []),
            ...(accountCreated
              ? [
                  "New to ServeProof? Sign in with this email address at the link below — your account is ready, with the request waiting.",
                ]
              : []),
            "Accept it from the Work tab only if this is your workplace identity. Otherwise, reject it.",
            "",
            accountCreated ? `${origin}/login` : `${origin}/me`,
          ].join("\n"),
        );
        invitationEmailSent = true;
      } catch (error) {
        this.logger.warn(
          `mapping invitation email failed for ${mapping.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { ...mapping, invitationEmailSent, accountCreated, heldUsdCents };
  }

  /**
   * Confirms a worker-accepted mapping, backfills existing shift evidence, and
   * attaches any held allocation shares that were computed before connection.
   */
  private async verifyMapping(id: string, verifiedBy: string) {
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
    const heldAllocationsAttached = await this.attachHeldAllocations(mapping);

    if (backfill.count > 0 || heldAllocationsAttached > 0) {
      try {
        await rebuildVenueIncome(this.prisma, mapping.venueId, verifiedBy, "SYSTEM");
      } catch (error) {
        this.logger.warn(
          `income rebuild after mapping ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { mapping: updated, backfilledShifts: backfill.count, heldAllocationsAttached };
  }

  /**
   * Attaches held allocation rows (computed while the worker was unmapped) to
   * the now-connected worker. If the worker already has a row in the same
   * batch (two external IDs, one person), the amounts merge into it.
   */
  private async attachHeldAllocations(mapping: {
    venueId: string;
    provider: string;
    externalWorkerId: string;
    workerId: string;
  }): Promise<number> {
    const held = await this.prisma.workerAllocation.findMany({
      where: {
        workerId: null,
        provider: mapping.provider,
        externalWorkerId: mapping.externalWorkerId,
        batch: { venueId: mapping.venueId },
      },
    });
    for (const allocation of held) {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.workerAllocation.findFirst({
          where: { batchId: allocation.batchId, workerId: mapping.workerId },
        });
        if (existing) {
          await tx.workerAllocation.update({
            where: { id: existing.id },
            data: {
              pooledTipUsdCents: { increment: allocation.pooledTipUsdCents },
              netAllocatedUsdCents: { increment: allocation.netAllocatedUsdCents },
            },
          });
          await tx.workerAllocation.delete({ where: { id: allocation.id } });
        } else {
          await tx.workerAllocation.update({
            where: { id: allocation.id },
            data: { workerId: mapping.workerId },
          });
        }
      });
    }
    return held.length;
  }

  /** Worker accepts or rejects a venue-proposed external identity connection. */
  async respondToMapping(id: string, userId: string, decision: "ACCEPT" | "REJECT") {
    const mapping = await this.prisma.externalWorkerAccount.findUnique({
      where: { id },
      include: { worker: { select: { userId: true } } },
    });
    if (!mapping) throw new NotFoundException(`Mapping ${id} not found`);
    if (mapping.worker.userId !== userId) {
      throw new ForbiddenException("This connection request belongs to another worker");
    }
    if (decision === "REJECT") {
      if (mapping.mappingStatus === "CONFIRMED") {
        throw new BadRequestException("A confirmed mapping cannot be rejected");
      }
      const rejected = await this.prisma.externalWorkerAccount.update({
        where: { id },
        data: { mappingStatus: "REJECTED", verifiedBy: userId, verifiedAt: new Date() },
      });
      return { mapping: rejected, backfilledShifts: 0, heldAllocationsAttached: 0 };
    }
    if (mapping.mappingStatus === "REJECTED") {
      throw new BadRequestException("A rejected mapping requires a new venue request");
    }
    if (mapping.mappingStatus === "CONFIRMED") {
      return { mapping, backfilledShifts: 0, heldAllocationsAttached: 0 };
    }
    return this.verifyMapping(id, userId);
  }
}
