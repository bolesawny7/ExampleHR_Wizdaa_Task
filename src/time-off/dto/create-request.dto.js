import { IsISO8601, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPORTED_LEAVE_TYPES = ['ANNUAL', 'SICK', 'PERSONAL', 'BEREAVEMENT'];

export class CreateRequestDto {
  @IsString() @MinLength(1) @MaxLength(64)
  locationId;

  @IsString() @IsIn(SUPPORTED_LEAVE_TYPES)
  leaveType;

  @IsISO8601({ strict: true })
  startDate;

  @IsISO8601({ strict: true })
  endDate;

  @IsOptional() @IsString() @MaxLength(500)
  reason;
}

export class RejectRequestDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason;
}
