import { Type } from 'class-transformer';
import {
  IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';

class ReconcileKeyDto {
  @IsString() @MaxLength(64) employeeId;
  @IsString() @MaxLength(64) locationId;
  @IsString() @MaxLength(32) leaveType;
}

/** POST /admin/reconcile body. */
export class ReconcileDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ReconcileKeyDto)
  key;

  @IsOptional() @IsInt() @Min(1) sinceMs;
  @IsOptional() @IsInt() @Min(1) limit;
}
